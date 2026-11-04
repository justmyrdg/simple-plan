"""
Camera media an admin saves by hand, and how long all camera media is kept.

  - Snapshots: a full-resolution photo of an area's network camera, saved on request.
  - Recordings: a video of it, started and stopped on request (see recorder.py).
  - Cleanup: photos and snapshots older than PHOTO_RETENTION_DAYS and recordings older than
    RECORDING_RETENTION_DAYS (0 = keep forever) are deleted every hour (Data Privacy Act).

Admins can also delete any of them at any time. Files live in storage.py (disk, or S3).
"""

import json
import os
from datetime import datetime, timedelta

import cv2
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import recorder, storage
from .auth import current_user, current_user_or_query_token
from .cameras import CameraError, camera_area, grab_frame
from .collection_tracker import PHOTO_RETENTION_DAYS
from .db import get_db
from .models import Detection, Recording, RecordingResult, Snapshot, User

RECORDING_RETENTION_DAYS = int(os.getenv("RECORDING_RETENTION_DAYS", "14"))
CLOUD_DELETE_FAILED = "Could not remove the file from cloud storage. Try again in a moment."

router = APIRouter(prefix="/api", tags=["media"])


class SnapshotIn(BaseModel):
    note: str = Field("", max_length=200)


def snapshot_out(s: Snapshot) -> dict:
    return {"id": s.id, "area_id": s.area_id, "taken_by": s.taken_by, "note": s.note, "created_at": s.created_at}


def recording_out(r: Recording) -> dict:
    seconds = ((r.ended_at or datetime.now()) - r.started_at).total_seconds()
    return {
        "id": r.id, "area_id": r.area_id, "started_by": r.started_by, "status": r.status, "error": r.error,
        "size": r.size, "started_at": r.started_at, "ended_at": r.ended_at, "seconds": max(0, round(seconds)),
    }


# ---------- snapshots ----------

@router.post("/cameras/{area_id}/snapshots", status_code=201)
def save_snapshot(area_id: int, body: SnapshotIn = SnapshotIn(), user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    area = camera_area(db, area_id)
    try:
        frame = grab_frame(area)
    except CameraError as e:
        raise HTTPException(503, str(e))
    row = Snapshot(area_id=area.id, taken_by=user.username, note=body.note.strip())
    db.add(row)
    db.flush()  # the id names the file
    name = f"{row.id}.jpg"
    storage.folder("snapshots").mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(storage.local_path("snapshots", name)), frame, [cv2.IMWRITE_JPEG_QUALITY, 92]):
        db.rollback()
        raise HTTPException(500, "Could not save the photo on the server.")
    db.commit()
    storage.upload_later("snapshots", name)
    return snapshot_out(row)


@router.get("/cameras/{area_id}/snapshots", dependencies=[Depends(current_user)])
def list_snapshots(area_id: int, db: Session = Depends(get_db)):
    rows = db.scalars(select(Snapshot).where(Snapshot.area_id == area_id).order_by(Snapshot.created_at.desc()).limit(200))
    return [snapshot_out(s) for s in rows]


@router.get("/snapshots/{snapshot_id}/file", dependencies=[Depends(current_user_or_query_token)])
def snapshot_file(snapshot_id: int, download: bool = False, db: Session = Depends(get_db)):
    s = db.get(Snapshot, snapshot_id)
    if s is None:
        raise HTTPException(404, "Snapshot not found")
    return storage.serve("snapshots", f"{s.id}.jpg", f"snapshot-{s.created_at:%Y%m%d-%H%M%S}.jpg" if download else None)


@router.delete("/snapshots/{snapshot_id}", status_code=204, dependencies=[Depends(current_user)])
def delete_snapshot(snapshot_id: int, db: Session = Depends(get_db)):
    s = db.get(Snapshot, snapshot_id)
    if s is None:
        raise HTTPException(404, "Snapshot not found")
    if not storage.delete("snapshots", f"{s.id}.jpg"):
        raise HTTPException(502, CLOUD_DELETE_FAILED)
    db.delete(s)
    db.commit()


# ---------- recordings ----------

@router.get("/cameras/{area_id}/recordings", dependencies=[Depends(current_user)])
def list_recordings(area_id: int, db: Session = Depends(get_db)):
    rows = db.scalars(select(Recording).where(Recording.area_id == area_id).order_by(Recording.started_at.desc()).limit(100))
    return {
        "items": [recording_out(r) for r in rows],
        "max_seconds": recorder.MAX_SECONDS,
        "cloud": storage.enabled(),
    }


@router.post("/cameras/{area_id}/recordings/start", status_code=201)
def start_recording(area_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    area = camera_area(db, area_id)
    row = Recording(area_id=area.id, started_by=user.username)
    db.add(row)
    db.commit()  # committed first: the recorder updates this row when ffmpeg ends
    try:
        recorder.start(row.id, area.id, area.camera_url)
    except recorder.RecorderError as e:
        db.delete(row)
        db.commit()
        raise HTTPException(e.status, str(e))
    return recording_out(row)


@router.post("/cameras/{area_id}/recordings/stop", dependencies=[Depends(current_user)])
def stop_recording(area_id: int, db: Session = Depends(get_db)):
    if not recorder.stop(area_id):
        raise HTTPException(409, "Nothing is being recorded for this area.")
    row = db.scalar(select(Recording).where(Recording.area_id == area_id).order_by(Recording.id.desc()).limit(1))
    return recording_out(row)


@router.get("/recordings/{recording_id}/file", dependencies=[Depends(current_user_or_query_token)])
def recording_file(recording_id: int, download: bool = False, db: Session = Depends(get_db)):
    r = db.get(Recording, recording_id)
    if r is None or r.status != "done":
        raise HTTPException(404, "Recording not found")
    return storage.serve("recordings", f"{r.id}.mp4", f"recording-{r.started_at:%Y%m%d-%H%M%S}.mp4" if download else None)


@router.get("/recordings/{recording_id}/results", dependencies=[Depends(current_user)])
def recording_results(recording_id: int, db: Session = Depends(get_db)):
    """The detector's verdict along the video: `t` is seconds from its start."""
    if db.get(Recording, recording_id) is None:
        raise HTTPException(404, "Recording not found")
    rows = db.scalars(select(RecordingResult).where(RecordingResult.recording_id == recording_id)
                      .order_by(RecordingResult.offset)).all()
    return [{"t": r.offset, "status": r.status, "score": r.score, "threshold": r.threshold,
             "cells": json.loads(r.cells) if r.cells else None} for r in rows]


@router.delete("/recordings/{recording_id}", status_code=204, dependencies=[Depends(current_user)])
def delete_recording(recording_id: int, db: Session = Depends(get_db)):
    r = db.get(Recording, recording_id)
    if r is None:
        raise HTTPException(404, "Recording not found")
    if r.status == "recording":
        raise HTTPException(409, "Stop the recording first.")
    if not storage.delete("recordings", f"{r.id}.mp4"):
        raise HTTPException(502, CLOUD_DELETE_FAILED)
    db.delete(r)
    db.commit()


# ---------- cleanup ----------

def purge_area(db: Session, area_id: int) -> bool:
    """Delete every saved file of an area before the area itself goes. False if S3 refused some of them."""
    recorder.stop(area_id)
    ok = True
    for s in db.scalars(select(Snapshot).where(Snapshot.area_id == area_id)).all():
        ok &= storage.delete("snapshots", f"{s.id}.jpg")
    for r in db.scalars(select(Recording).where(Recording.area_id == area_id)).all():
        ok &= storage.delete("recordings", f"{r.id}.mp4")
    for d in db.scalars(select(Detection).where(Detection.area_id == area_id, Detection.photo != "")).all():
        ok &= storage.delete("photos", d.photo)
    return ok


_last_cleanup: datetime | None = None


def cleanup_media(db: Session, now: datetime | None = None):
    """Delete camera media past its retention time, at most once an hour."""
    global _last_cleanup
    now = now or datetime.now()
    if _last_cleanup and now - _last_cleanup < timedelta(hours=1):
        return
    _last_cleanup = now
    removed = {"photos": 0, "snapshots": 0, "recordings": 0}

    if PHOTO_RETENTION_DAYS > 0:
        cutoff = now - timedelta(days=PHOTO_RETENTION_DAYS)
        for d in db.scalars(select(Detection).where(Detection.photo != "", Detection.created_at < cutoff)).all():
            if storage.delete("photos", d.photo):
                d.photo = ""
                removed["photos"] += 1
        for s in db.scalars(select(Snapshot).where(Snapshot.created_at < cutoff)).all():
            if storage.delete("snapshots", f"{s.id}.jpg"):
                db.delete(s)
                removed["snapshots"] += 1
    if RECORDING_RETENTION_DAYS > 0:
        cutoff = now - timedelta(days=RECORDING_RETENTION_DAYS)
        for r in db.scalars(select(Recording).where(Recording.status != "recording", Recording.started_at < cutoff)).all():
            if storage.delete("recordings", f"{r.id}.mp4"):
                db.delete(r)
                removed["recordings"] += 1
    db.commit()
    if any(removed.values()):
        print("[media] deleted expired " + ", ".join(f"{n} {k}" for k, n in removed.items() if n))
