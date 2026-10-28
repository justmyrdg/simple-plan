"""
Collection tracking: was each scheduled pickup actually collected?

For every scheduled pickup the camera history (Detection rows) in a window around the
scheduled time is judged:

      scheduled time - BEFORE ......... scheduled time ......... + AFTER
      area full ──────────▶ area clean (and stays clean CLEAN_HOLD)  = collected
      area full ──────────────────────────────────────────── window ends = missed  (admin SMS)
      never full in the window                                         = no_waste
      camera not reporting                                             = no_data

A collection counts even when the truck is early (inside the BEFORE part of the window).
Results are rows in `collections`; photos saved on status changes are the proof.
No truck detection is needed: the area going from full to clean is the evidence.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import current_user, current_user_or_query_token
from .db import get_db
from .models import Area, Collection, Detection, Schedule, SmsLog
from .pickups import occurrences
from .sms import InvalidPhone, normalize_phone, send_sms

BEFORE = timedelta(minutes=int(os.getenv("COLLECTION_BEFORE_MINUTES", "120")))
AFTER = timedelta(minutes=int(os.getenv("COLLECTION_AFTER_MINUTES", "240")))
CLEAN_HOLD = timedelta(minutes=3)       # clean must last this long, so a brief misread doesn't count
STALE = timedelta(minutes=10)           # no camera report for this long = camera not watching
LATE_AFTER = timedelta(minutes=int(os.getenv("COLLECTION_LATE_MINUTES", "30")))
LOOKBACK = timedelta(days=7)            # how far back unjudged pickups are caught up (e.g. after downtime)
PHOTO_RETENTION_DAYS = int(os.getenv("PHOTO_RETENTION_DAYS", "30"))

PHOTO_DIR = Path(__file__).resolve().parent / "captures"
FINAL = ("collected", "missed", "no_waste", "no_data")


@dataclass
class Point:
    t: datetime
    status: str  # 'trash' | 'clean'


@dataclass
class Verdict:
    status: str
    full_since: datetime | None = None
    collected_at: datetime | None = None


def judge(points: list[Point], scheduled: datetime, now: datetime) -> Verdict:
    """
    Decide one pickup from the camera history. `points` are the area's status reports, oldest
    first: the last one before the window (if any) and every one inside the window up to now.
    """
    win_start, win_end = scheduled - BEFORE, scheduled + AFTER
    horizon = min(now, win_end)
    # a report from before the window only counts if the camera was still reporting at the start
    pts = [p for p in points if win_start <= p.t <= horizon]
    carry = [p for p in points if p.t < win_start]
    if carry and win_start - carry[-1].t <= STALE:
        pts.insert(0, carry[-1])

    full_since = None
    for i, p in enumerate(pts):
        if p.status == "trash":
            full_since = full_since or p.t
            continue
        if full_since is None:
            continue
        if p.t - full_since < CLEAN_HOLD:
            full_since = None  # full for only a moment: a misread, not a pile of trash
            continue
        # clean after full: it must stay clean for CLEAN_HOLD to count as a collection
        if any(q.status == "trash" and q.t < p.t + CLEAN_HOLD for q in pts[i + 1:]):
            continue
        if now >= p.t + CLEAN_HOLD:
            return Verdict("collected", full_since, p.t)

    if now < win_end:
        return Verdict("pending", full_since)
    last_seen = pts[-1].t if pts else None
    if last_seen is None or win_end - last_seen > STALE * 3:
        return Verdict("no_data", full_since)  # the camera stopped reporting: can't judge
    if full_since is None:
        return Verdict("no_waste")
    return Verdict("missed", full_since)


# ---------- updating the collections table ----------

def alert_admins(db: Session, area: Area, text: str):
    """SMS every number in ADMIN_PHONES (comma-separated); always printed to the console."""
    print(f"[collection] ALERT {text}")
    for raw in filter(None, (p.strip() for p in os.getenv("ADMIN_PHONES", "").split(","))):
        try:
            phone = normalize_phone(raw)
        except InvalidPhone:
            print(f"[collection] ADMIN_PHONES has an invalid number: {raw}")
            continue
        status, error = send_sms(phone, text)
        db.add(SmsLog(area_id=area.id, phone=phone, message=text, status=status, error=error, kind="alert"))


def _photo_detection(db: Session, area_id: int, status: str, until: datetime) -> int | None:
    """Newest saved photo of the area with this status, taken no later than `until`."""
    return db.scalar(
        select(Detection.id).where(
            Detection.area_id == area_id, Detection.status == status, Detection.photo != "",
            Detection.created_at <= until,
        ).order_by(Detection.created_at.desc()).limit(1)
    )


def update_collections(db: Session, now: datetime | None = None) -> list[str]:
    """Judge every scheduled pickup whose window has started; returns a line per newly decided one."""
    now = now or datetime.now()
    decided = []
    for s in db.scalars(select(Schedule)).all():
        area = s.area
        if not area.camera_enabled:
            continue
        for dt in occurrences(s, now - LOOKBACK - AFTER, now + BEFORE):
            if dt - BEFORE > now:
                continue
            row = db.scalar(select(Collection).where(Collection.area_id == area.id, Collection.scheduled_for == dt))
            if row is not None and row.status in FINAL:
                continue
            start = dt - BEFORE - STALE
            rows = db.execute(
                select(Detection.created_at, Detection.status).where(
                    Detection.area_id == area.id, Detection.created_at >= start, Detection.created_at <= min(now, dt + AFTER),
                ).order_by(Detection.created_at)
            ).all()
            v = judge([Point(t, st) for t, st in rows], dt, now)
            if row is None:
                row = Collection(area_id=area.id, schedule_id=s.id, scheduled_for=dt)
                db.add(row)
            row.status, row.full_since, row.collected_at, row.updated_at = v.status, v.full_since, v.collected_at, now
            if v.status == "collected":
                row.before_detection_id = _photo_detection(db, area.id, "trash", v.collected_at)
                row.after_detection_id = _photo_detection(db, area.id, "clean", v.collected_at + CLEAN_HOLD)
                if not area.last_collected_at or v.collected_at > area.last_collected_at:
                    area.last_collected_at = v.collected_at
            elif v.status == "missed":
                row.before_detection_id = _photo_detection(db, area.id, "trash", dt + AFTER)
                if not row.alerted:
                    row.alerted = True
                    when = f"{dt:%b} {dt.day} {dt:%I:%M %p}".replace(" 0", " ")
                    alert_admins(db, area, f"TrashWatch alert: {area.name} was not collected. The "
                                           f"{when} pickup passed and the area still looks full.")
            if v.status in FINAL:
                decided.append(f"{area.name} {dt:%Y-%m-%d %H:%M}: {v.status}")
            db.commit()
    return decided


_last_cleanup: datetime | None = None


def cleanup_photos(db: Session, now: datetime | None = None):
    """Delete camera photos older than PHOTO_RETENTION_DAYS, at most once an hour."""
    global _last_cleanup
    now = now or datetime.now()
    if PHOTO_RETENTION_DAYS <= 0 or (_last_cleanup and now - _last_cleanup < timedelta(hours=1)):
        return
    _last_cleanup = now
    old = db.scalars(select(Detection).where(
        Detection.photo != "", Detection.created_at < now - timedelta(days=PHOTO_RETENTION_DAYS)
    )).all()
    for d in old:
        (PHOTO_DIR / d.photo).unlink(missing_ok=True)
        d.photo = ""
    if old:
        db.commit()
        print(f"[collection] deleted {len(old)} photo(s) older than {PHOTO_RETENTION_DAYS} days")


# ---------- output ----------

def collection_out(c: Collection, area_name: str) -> dict:
    late = None
    if c.collected_at:
        late = round((c.collected_at - c.scheduled_for).total_seconds() / 60)
    hours_full = None
    if c.collected_at and c.full_since:
        hours_full = round((c.collected_at - c.full_since).total_seconds() / 3600, 2)
    return {
        "id": c.id, "area_id": c.area_id, "area": area_name, "status": c.status,
        "scheduled_for": c.scheduled_for, "full_since": c.full_since, "collected_at": c.collected_at,
        "minutes_from_schedule": late,  # negative = before the scheduled time
        "on_time": late is not None and late <= LATE_AFTER.total_seconds() / 60,
        "hours_full": hours_full,
        "before_photo": c.before_detection_id, "after_photo": c.after_detection_id,
    }


def list_collections(db: Session, since: datetime, until: datetime | None = None, area_id: int | None = None) -> list[dict]:
    q = (select(Collection, Area.name).join(Area, Area.id == Collection.area_id)
         .where(Collection.scheduled_for >= since).order_by(Collection.scheduled_for.desc()))
    if until is not None:
        q = q.where(Collection.scheduled_for <= until)
    if area_id is not None:
        q = q.where(Collection.area_id == area_id)
    return [collection_out(c, name) for c, name in db.execute(q).all()]


router = APIRouter(prefix="/api", tags=["collections"])


@router.get("/collections", dependencies=[Depends(current_user)])
def get_collections(area_id: int | None = None, days: int = 30, db: Session = Depends(get_db)):
    return list_collections(db, datetime.now() - timedelta(days=max(1, min(days, 366))), area_id=area_id)


@router.get("/detections/{detection_id}/photo", dependencies=[Depends(current_user_or_query_token)])
def detection_photo(detection_id: int, db: Session = Depends(get_db)):
    d = db.get(Detection, detection_id)
    if d is None or not d.photo or not (PHOTO_DIR / d.photo).exists():
        raise HTTPException(404, "Photo not found")
    return FileResponse(PHOTO_DIR / d.photo, media_type="image/jpeg")
