"""
Network (IP) cameras: the server reads each area's camera stream itself.

An area's `camera_url` is anything OpenCV can open, usually RTSP, e.g.
    rtsp://admin:password@192.168.1.64:554/Streaming/Channels/102
(Hikvision: channel 101 is the main stream, 102 the lighter sub-stream).
A plain number such as "0" opens a camera plugged into the server.

Each camera gets a reader thread that keeps only the newest frame, so a
snapshot is never seconds behind. A reader stops by itself after
IDLE_STOP seconds without anyone asking for frames.
"""

import asyncio
import os
import threading
import time

# RTSP over TCP: UDP drops packets on busy Wi-Fi and gives smeared frames
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import APIRouter, Depends, HTTPException  # noqa: E402
from fastapi.responses import Response, StreamingResponse  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from .auth import current_user, current_user_or_query_token  # noqa: E402
from .db import get_db  # noqa: E402
from .models import Area  # noqa: E402

IDLE_STOP = 60          # seconds without readers before a stream is closed
RECONNECT_DELAY = 5     # seconds between reconnect attempts
STALE_AFTER = 10        # a frame older than this means the camera stopped sending
STREAM_FPS = 8          # frame rate of the MJPEG preview sent to browsers
STREAM_MAX_WIDTH = 1280


class CameraError(Exception):
    pass


class CameraStream:
    def __init__(self, url: str):
        self.url = url
        self.frame: np.ndarray | None = None
        self.frame_at = 0.0
        self.seq = 0
        self.error = ""
        self.last_used = time.monotonic()
        self._stop = threading.Event()
        self._new_frame = threading.Condition()
        self._thread = threading.Thread(target=self._run, daemon=True, name="camera-reader")
        self._thread.start()

    def _open(self) -> cv2.VideoCapture:
        if self.url.strip().isdigit():
            return cv2.VideoCapture(int(self.url))
        return cv2.VideoCapture(self.url, cv2.CAP_FFMPEG, [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000,
            cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000,
        ])

    def _run(self):
        while not self._stop.is_set():
            cap = self._open()
            if not cap.isOpened():
                self.error = "Cannot connect to the camera. Check the address, username and password."
                cap.release()
                self._stop.wait(RECONNECT_DELAY)
                continue
            self.error = ""
            while not self._stop.is_set():
                ok, frame = cap.read()
                if not ok:
                    self.error = "The camera stopped sending video. Reconnecting…"
                    break
                with self._new_frame:
                    self.frame, self.frame_at = frame, time.monotonic()
                    self.seq += 1
                    self._new_frame.notify_all()
                if time.monotonic() - self.last_used > IDLE_STOP:
                    self._stop.set()
            cap.release()
            if not self._stop.is_set():
                self._stop.wait(RECONNECT_DELAY)

    @property
    def alive(self) -> bool:
        return self._thread.is_alive() and not self._stop.is_set()

    def stop(self):
        self._stop.set()

    def latest(self, timeout: float = 10) -> tuple[np.ndarray, int]:
        """Newest frame (and its sequence number), waiting up to `timeout` s for the first one."""
        self.last_used = time.monotonic()
        deadline = time.monotonic() + timeout
        with self._new_frame:
            while self.frame is None or time.monotonic() - self.frame_at > STALE_AFTER:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise CameraError(self.error or "No video from the camera yet.")
                self._new_frame.wait(min(left, 0.5))
            return self.frame, self.seq


_streams: dict[int, CameraStream] = {}
_lock = threading.Lock()


def get_stream(area_id: int, url: str) -> CameraStream:
    """The running reader for this area, (re)started if missing, stopped, or the URL changed."""
    with _lock:
        s = _streams.get(area_id)
        if s is None or not s.alive or s.url != url:
            if s is not None:
                s.stop()
            s = _streams[area_id] = CameraStream(url)
        return s


def grab_frame(area: Area, timeout: float = 10) -> np.ndarray:
    """Blocking; call through asyncio.to_thread from async code."""
    if not area.camera_url:
        raise CameraError("This area has no network camera address.")
    return get_stream(area.id, area.camera_url).latest(timeout)[0]


def stop_all():
    with _lock:
        for s in _streams.values():
            s.stop()
        _streams.clear()


def _encode(frame: np.ndarray, max_width: int = STREAM_MAX_WIDTH, quality: int = 80) -> bytes:
    h, w = frame.shape[:2]
    if w > max_width:
        frame = cv2.resize(frame, (max_width, round(h * max_width / w)), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])[1].tobytes()


# ---------- endpoints ----------

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


def camera_area(db: Session, area_id: int) -> Area:
    area = db.get(Area, area_id)
    if area is None:
        raise HTTPException(404, "Area not found")
    if not area.camera_url:
        raise HTTPException(400, "This area has no network camera address. Add one on the Areas page.")
    return area


@router.get("/{area_id}/snapshot", dependencies=[Depends(current_user)])
async def snapshot(area_id: int, db: Session = Depends(get_db)):
    area = camera_area(db, area_id)
    try:
        frame = await asyncio.to_thread(grab_frame, area)
    except CameraError as e:
        raise HTTPException(503, str(e))
    return Response(await asyncio.to_thread(_encode, frame, 10_000, 90), media_type="image/jpeg")


@router.get("/{area_id}/stream", dependencies=[Depends(current_user_or_query_token)])
async def stream(area_id: int, db: Session = Depends(get_db)):
    """MJPEG preview for an <img> tag (which can't send headers, hence ?token=)."""
    area = camera_area(db, area_id)
    cam = get_stream(area.id, area.camera_url)
    try:
        await asyncio.to_thread(cam.latest)
    except CameraError as e:
        raise HTTPException(503, str(e))

    async def frames():
        last_seq = -1
        while True:
            try:
                frame, seq = await asyncio.to_thread(cam.latest, 30)
            except CameraError:
                return
            if seq != last_seq:
                last_seq = seq
                jpg = await asyncio.to_thread(_encode, frame)
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n"
            await asyncio.sleep(1 / STREAM_FPS)

    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store"})
