"""
FastAPI server for TrashWatch.

Run from the project root:
    python -m uvicorn backend.main:app --port 8000
or from inside backend/:
    python main.py

Settings (optional) go in backend/.env as KEY=value lines:
    ADMIN_PASSWORD         password for the first 'admin' account (default: admin123)
    SMSGATE_USERNAME/PASSWORD  free SMS through an Android phone (sms-gate.app)
    SEMAPHORE_API_KEY      send real SMS through semaphore.co (otherwise simulated)
    SEMAPHORE_SENDER_NAME  approved sender name on Semaphore
    ADMIN_PHONES           numbers that get an SMS when a pickup is missed (comma-separated)
    PUBLIC_URL             public site address, adds an opt-out link to SMS (e.g. https://trash.example.com)
    JWT_SECRET             token signing secret (otherwise generated into backend/.jwt_secret)
    CAMERA_CHECK_SECONDS   how often the server checks each network camera itself (default 30, 0 = off)
    CAMERA_THRESHOLD       trash threshold for those checks (default 0.5)
"""

import asyncio
import base64
import os
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_env():
    env = Path(__file__).resolve().parent / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from sqlalchemy import inspect, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from backend import areas, auth, cameras, collection_tracker, dashboard, public, reports  # noqa: E402
from backend.db import Base, SessionLocal, engine, get_db  # noqa: E402
from backend.models import Area, Detection, User  # noqa: E402
from backend.scheduler import reminder_loop  # noqa: E402
from trash_detector import DEFAULT_HEAD, TrashDetector  # noqa: E402

# store a detection row at most this often per area (plus on every status change)
DETECTION_LOG_EVERY = timedelta(seconds=60)

CAMERA_CHECK_SECONDS = float(os.getenv("CAMERA_CHECK_SECONDS", "30"))
CAMERA_THRESHOLD = float(os.getenv("CAMERA_THRESHOLD", "0.5"))

# columns added to existing tables after the first release: {table: {column: SQL type}}
ADDED_COLUMNS = {
    "areas": {
        "camera_url": "VARCHAR(500) NOT NULL DEFAULT ''",
        "last_collected_at": "DATETIME",
    },
    "contacts": {
        "language": "VARCHAR(3) NOT NULL DEFAULT 'en'",
        "consent_at": "DATETIME",
        "opted_out_at": "DATETIME",
    },
    "detections": {
        "photo": "VARCHAR(64) NOT NULL DEFAULT ''",
    },
    "schedules": {
        "notify_at_pickup": "BOOLEAN NOT NULL DEFAULT 1",
    },
}


def init_db():
    Base.metadata.create_all(engine)
    # create_all doesn't add columns to existing tables; add the ones introduced later
    with engine.begin() as conn:
        for table, columns in ADDED_COLUMNS.items():
            existing = {c["name"] for c in inspect(conn).get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
    with SessionLocal() as db:
        if db.scalar(select(User.id).limit(1)) is None:
            password = os.getenv("ADMIN_PASSWORD", "admin123")
            db.add(User(username="admin", full_name="Administrator", password_hash=auth.hash_password(password)))
            print(f"[setup] created login  username: admin  password: {password}  (change it after logging in)")
        if db.scalar(select(Area.id).limit(1)) is None:
            # one camera for testing; move the pin on the Areas page
            db.add(Area(name="Test Area", address="Batangas City", lat=13.7565, lng=121.0583,
                        camera_enabled=True, camera_label="Camera 1"))
            print("[setup] created 'Test Area' with Camera 1")
        db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    tasks = [asyncio.create_task(reminder_loop()), asyncio.create_task(camera_watch_loop())]
    yield
    for t in tasks:
        t.cancel()
    cameras.stop_all()


app = FastAPI(title="TrashWatch API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(areas.router)
app.include_router(dashboard.router)
app.include_router(public.router)
app.include_router(cameras.router)
app.include_router(collection_tracker.router)
app.include_router(reports.router)

# Load the model once at startup; it's shared by every request.
detector = TrashDetector(head_path=DEFAULT_HEAD)
# the detector keeps its threshold as state, so only one analysis runs at a time
_detector_lock = threading.Lock()


def run_detector(bgr: np.ndarray, threshold: float, grid: int) -> tuple[dict, bytes]:
    """Blocking: analysis result plus the annotated JPEG. Call through asyncio.to_thread."""
    with _detector_lock:
        detector.threshold = threshold
        result = detector.analyze(bgr, grid)
        annotated = detector.annotate(bgr, result)
    return result, cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


def detect_response(result: dict, jpg: bytes, threshold: float, filename: str | None) -> dict:
    return {
        "filename": filename,
        "is_trash": bool(result["is_trash"]),
        "label": "FULL OF TRASH" if result["is_trash"] else "CLEAN",
        "score": round(result["score"], 4),
        "threshold": threshold,
        "trash_cell_ratio": result["trash_cell_ratio"],
        "cells": result["cells"].round(4).tolist() if result["cells"] is not None else None,
        "annotated_image": "data:image/jpeg;base64," + base64.b64encode(jpg).decode(),
        "model": "trained" if detector.head is not None else "zero-shot",
    }


def check_threshold_grid(threshold: float, grid: int):
    if not 0 <= threshold <= 1:
        raise HTTPException(400, "threshold must be between 0 and 1")
    if not 0 <= grid <= 6:
        raise HTTPException(400, "grid must be between 0 and 6")


@app.get("/api/health")
def health():
    return {"status": "ok", "model": "trained" if detector.head is not None else "zero-shot"}


def record_detection(db: Session, area_id: int, is_trash: bool, score: float, source: str,
                     bgr: np.ndarray | None = None):
    area = db.get(Area, area_id)
    if area is None:
        raise HTTPException(404, "Area not found")
    status = "trash" if is_trash else "clean"
    now = datetime.now()
    last = db.scalar(
        select(Detection).where(Detection.area_id == area_id).order_by(Detection.created_at.desc()).limit(1)
    )
    changed = last is None or last.status != status
    if changed or now - last.created_at >= DETECTION_LOG_EVERY:
        det = Detection(area_id=area_id, status=status, score=score, source=source, created_at=now)
        db.add(det)
        if changed and bgr is not None:
            # a photo on every status change is the before/after proof for collections
            db.flush()
            det.photo = save_photo(det.id, bgr)
    area.last_status, area.last_score, area.last_checked_at = status, score, now
    db.commit()


def save_photo(detection_id: int, bgr: np.ndarray, max_width: int = 1280) -> str:
    collection_tracker.PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    h, w = bgr.shape[:2]
    if w > max_width:
        bgr = cv2.resize(bgr, (max_width, round(h * max_width / w)), interpolation=cv2.INTER_AREA)
    name = f"{detection_id}.jpg"
    cv2.imwrite(str(collection_tracker.PHOTO_DIR / name), bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return name


@app.post("/api/detect")
async def detect(
    file: UploadFile = File(...),
    threshold: float = Form(0.5),
    grid: int = Form(3),
    area_id: int | None = Form(None),
    source: str = Form("live"),
    _user: User = Depends(auth.current_user),
    db: Session = Depends(get_db),
):
    check_threshold_grid(threshold, grid)
    data = await file.read()
    bgr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(400, "Could not read the image. Upload a JPG, PNG, BMP or WEBP file.")

    result, jpg = await asyncio.to_thread(run_detector, bgr, threshold, grid)

    if area_id is not None:
        record_detection(db, area_id, bool(result["is_trash"]), float(result["score"]),
                         "upload" if source == "upload" else "live", bgr)

    return detect_response(result, jpg, threshold, file.filename)


@app.post("/api/cameras/{area_id}/detect")
async def detect_camera(
    area_id: int,
    threshold: float = Form(0.5),
    grid: int = Form(3),
    _user: User = Depends(auth.current_user),
    db: Session = Depends(get_db),
):
    """Analyze the newest frame from an area's network camera and record it as the area's status."""
    check_threshold_grid(threshold, grid)
    area = cameras.camera_area(db, area_id)
    try:
        bgr = await asyncio.to_thread(cameras.grab_frame, area)
    except cameras.CameraError as e:
        raise HTTPException(503, str(e))
    result, jpg = await asyncio.to_thread(run_detector, bgr, threshold, grid)
    record_detection(db, area_id, bool(result["is_trash"]), float(result["score"]), "live", bgr)
    return detect_response(result, jpg, threshold, f"{area.name}.jpg")


async def camera_watch_loop():
    """Check every network camera on a timer, so areas stay up to date with no browser open."""
    if CAMERA_CHECK_SECONDS <= 0:
        return
    errors: dict[int, str] = {}  # print each camera problem once, not every round
    while True:
        with SessionLocal() as db:
            watched = db.scalars(select(Area).where(Area.camera_enabled, Area.camera_url != "")).all()
        for area in watched:
            try:
                bgr = await asyncio.to_thread(cameras.grab_frame, area)
                result, _ = await asyncio.to_thread(run_detector, bgr, CAMERA_THRESHOLD, 3)
                with SessionLocal() as db:
                    record_detection(db, area.id, bool(result["is_trash"]), float(result["score"]), "live", bgr)
                if errors.pop(area.id, None):
                    print(f"[camera] {area.name}: back online")
            except cameras.CameraError as e:
                if errors.get(area.id) != str(e):
                    errors[area.id] = str(e)
                    print(f"[camera] {area.name}: {e}")
            except Exception as e:  # keep watching the other cameras
                print(f"[camera] {area.name}: check failed: {e!r}")
        await asyncio.sleep(CAMERA_CHECK_SECONDS)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
