"""
Manual video recording of an area's network camera.

An admin starts and stops a recording; the server runs `ffmpeg` against the camera's address and
copies the video as it is (no re-encoding, so little CPU) into a fragmented MP4, which browsers can
play and which stays playable even if the server dies mid-recording. Audio is never recorded.
A recording has no time limit unless RECORDING_MAX_SECONDS is set (0 = until stopped); it also ends by
itself if the disk is nearly full. When it ends the file is handed to storage (uploaded to S3 and
deleted from disk when S3 is on).

ffmpeg opens its own connection to the camera next to the one used for live detection; some
cameras allow only a few streams at once, so point the area at the lighter sub-stream if needed.
If the camera sends H.265, most browsers can't play the result (download it instead).

    RECORDING_MAX_SECONDS     longest recording (default 0 = no limit)
    RECORDING_MAX_CONCURRENT  recordings at the same time (default 2)
    RECORDING_MIN_FREE_MB     refuse to start with less free disk than this (default 1024)
    FFMPEG_BIN                path to ffmpeg; otherwise the one on PATH, else the imageio-ffmpeg copy
"""

import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import storage
from .db import SessionLocal
from .models import Recording

MAX_SECONDS = int(os.getenv("RECORDING_MAX_SECONDS", "0"))  # 0 = until stopped
MAX_CONCURRENT = int(os.getenv("RECORDING_MAX_CONCURRENT", "2"))
MIN_FREE_BYTES = int(os.getenv("RECORDING_MIN_FREE_MB", "1024")) * 1024 * 1024
CONNECT_SECONDS = 30  # ffmpeg creates the output file once the camera answers; none by then = unreachable
DISK_STOP_BYTES = 200 * 1024 * 1024  # a running recording is closed cleanly when free disk drops below this
MIN_USEFUL_BYTES = 4096  # a file smaller than this holds only the MP4 header: nothing was recorded
KIND = "recordings"


class RecorderError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass
class _Active:
    recording_id: int
    area_id: int
    url: str
    proc: subprocess.Popen
    log_path: str
    stopping: bool = False  # ended on purpose (stop button or time limit), not because the camera dropped
    problem: str = ""       # why the watcher ended it, if it had to
    video_start: float | None = None  # monotonic time the file appeared, i.e. second 0 of the video
    done: threading.Event = field(default_factory=threading.Event)

    @property
    def name(self) -> str:
        return f"{self.recording_id}.mp4"


_active: dict[int, _Active] = {}  # by area id
_lock = threading.Lock()


def ffmpeg_exe() -> str | None:
    exe = os.getenv("FFMPEG_BIN") or shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def is_recording(area_id: int) -> bool:
    return area_id in _active


def active_names() -> set[tuple[str, str]]:
    """Files still being written; the S3 retry sweep must leave them alone."""
    with _lock:
        return {(KIND, a.name) for a in _active.values()}


def video_positions() -> list[tuple[int, int, float]]:
    """(recording id, area id, seconds into the video now) for recordings whose camera has answered."""
    now = time.monotonic()
    with _lock:
        return [(a.recording_id, a.area_id, now - a.video_start)
                for a in _active.values() if a.video_start is not None and not a.stopping]


def start(recording_id: int, area_id: int, url: str):
    exe = ffmpeg_exe()
    if exe is None:
        raise RecorderError("ffmpeg is not installed on the server (pip install imageio-ffmpeg).", 503)
    if url.strip().isdigit():
        raise RecorderError("Recording needs a network camera address (RTSP or HTTP).", 400)
    out_dir = storage.folder(KIND)
    out_dir.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(out_dir).free < MIN_FREE_BYTES:
        raise RecorderError("The server is low on disk space. Delete old recordings first.", 507)

    cmd = [exe, "-hide_banner", "-loglevel", "error"]
    if url.lower().startswith("rtsp"):
        cmd += ["-rtsp_transport", "tcp"]
    name = f"{recording_id}.mp4"
    cmd += ["-i", url]
    if MAX_SECONDS > 0:
        cmd += ["-t", str(MAX_SECONDS)]
    cmd += ["-an", "-c:v", "copy",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-y", str(out_dir / name)]
    log_path = str(out_dir / f"{recording_id}.log")

    with _lock:
        if area_id in _active:
            raise RecorderError("This area is already being recorded.", 409)
        if len(_active) >= MAX_CONCURRENT:
            raise RecorderError(f"Too many recordings at once (limit {MAX_CONCURRENT}). Stop one first.", 409)
        with open(log_path, "wb") as log:
            # stdin stays open: writing "q" to it is how ffmpeg is asked to finish the file cleanly
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
        a = _Active(recording_id, area_id, url, proc, log_path)
        _active[area_id] = a
    threading.Thread(target=_watch, args=(a,), daemon=True, name=f"recording-{recording_id}").start()


def stop(area_id: int, wait: float = 15) -> bool:
    """Ask the recording to finish and wait until its file is saved. False if nothing was recording."""
    with _lock:
        a = _active.get(area_id)
    if a is None:
        return False
    _ask_to_finish(a)
    if not a.done.wait(wait):
        a.proc.terminate()
        a.done.wait(5)
    return True


def _ask_to_finish(a: _Active):
    """Have ffmpeg close the file properly (it does when it reads "q")."""
    a.stopping = True
    try:
        a.proc.stdin.write(b"q")
        a.proc.stdin.flush()
    except OSError:
        a.proc.terminate()


def stop_all():
    with _lock:
        ids = list(_active)
    for area_id in ids:
        stop(area_id)


def _clean(text: str, url: str) -> str:
    """Last lines of ffmpeg's error output, with the camera address (and its password) removed."""
    text = text.replace(url, "<camera>")
    return re.sub(r"(\w+)://[^@\s/]+@", r"\1://***@", text).strip()[-300:]


def _watch(a: _Active):
    path = storage.local_path(KIND, a.name)
    started = time.monotonic()
    kill_at: float | None = None  # when to give up on a recording this loop asked to finish
    next_disk_check = 0.0
    try:
        # ffmpeg's own -t counts the camera's timestamps, so the real-time limit is enforced here as well
        while a.proc.poll() is None:
            now = time.monotonic()
            waited = now - started
            if a.video_start is None and path.exists():
                a.video_start = now
            if not path.exists() and waited > CONNECT_SECONDS:
                a.problem = f"Could not connect to the camera within {CONNECT_SECONDS} seconds."
                a.proc.kill()
            elif not a.stopping:
                if MAX_SECONDS > 0 and waited > MAX_SECONDS + 2:
                    _ask_to_finish(a)
                    kill_at = now + 13
                elif now >= next_disk_check:  # with no time limit, one recording must not fill the disk
                    next_disk_check = now + 10
                    if shutil.disk_usage(path.parent).free < DISK_STOP_BYTES:
                        a.problem = "Stopped because the server is almost out of disk space."
                        _ask_to_finish(a)
                        kill_at = now + 15
            elif kill_at is not None and now > kill_at:  # asked to finish but it didn't (camera went silent)
                a.proc.kill()
            time.sleep(0.5)
        a.proc.wait()
    finally:
        try:
            _finish(a)
        except Exception as e:
            print(f"[recording] {a.recording_id}: could not save the result: {e!r}")
        finally:
            with _lock:
                _active.pop(a.area_id, None)
            a.done.set()


def _finish(a: _Active):
    path = storage.local_path(KIND, a.name)
    size = path.stat().st_size if path.exists() else 0
    try:
        with open(a.log_path, "rb") as f:
            detail = _clean(f.read().decode(errors="replace"), a.url)
        os.remove(a.log_path)
    except OSError:
        detail = ""
    useful = size >= MIN_USEFUL_BYTES
    with SessionLocal() as db:
        row = db.get(Recording, a.recording_id)
        if row is None:  # its area was deleted meanwhile
            storage.delete(KIND, a.name)
            return
        row.ended_at = datetime.now()
        row.size = size if useful else 0
        if useful:
            row.status = "done"
            if a.problem:
                row.error = a.problem
            elif a.proc.returncode not in (0, None) and not a.stopping:
                row.error = ("The recording ended early. " + detail).strip()
        else:
            row.status = "failed"
            row.error = a.problem or detail or "The camera sent no video."
            path.unlink(missing_ok=True)
        db.commit()
    if useful:
        storage.upload_later(KIND, a.name)


def recover(db: Session):
    """After a restart, close recordings that were running when the server stopped."""
    for row in db.scalars(select(Recording).where(Recording.status == "recording")).all():
        path = storage.local_path(KIND, f"{row.id}.mp4")
        size = path.stat().st_size if path.exists() else 0
        row.ended_at = datetime.fromtimestamp(path.stat().st_mtime) if size else datetime.now()
        if size >= MIN_USEFUL_BYTES:
            row.status, row.size, row.error = "done", size, "The server restarted during this recording."
        else:
            row.status, row.error = "failed", "The server restarted during this recording."
            path.unlink(missing_ok=True)
        (storage.folder(KIND) / f"{row.id}.log").unlink(missing_ok=True)
    db.commit()
