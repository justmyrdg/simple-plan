"""Endpoints residents can use without logging in: find an area and see its pickup schedule."""

import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .collection_tracker import PHOTO_RETENTION_DAYS
from .db import get_db
from .models import Area, Contact
from .pickups import describe, upcoming
from .sms import InvalidPhone, normalize_phone

router = APIRouter(prefix="/api/public", tags=["public"])


def _summary(a: Area, now: datetime) -> dict:
    nxt = upcoming(a.schedules, now, days=14)
    return {
        "id": a.id,
        "name": a.name,
        "address": a.address,
        "lat": a.lat,
        "lng": a.lng,
        "status": a.last_status,
        "status_checked_at": a.last_checked_at,
        "last_collected_at": a.last_collected_at,
        "next_pickup": nxt[0][0] if nxt else None,
        "next_pickup_truck": nxt[0][1].truck if nxt else None,
    }


@router.get("/areas")
def public_areas(db: Session = Depends(get_db)):
    now = datetime.now()
    return [_summary(a, now) for a in db.scalars(select(Area).order_by(Area.name)).all()]


@router.get("/areas/{area_id}")
def public_area(area_id: int, db: Session = Depends(get_db)):
    a = db.get(Area, area_id)
    if a is None:
        raise HTTPException(404, "Area not found")
    now = datetime.now()
    pickups = upcoming(a.schedules, now, days=14)
    return {
        **_summary(a, now),
        "regular_schedule": [
            {"description": describe(s), "truck": s.truck, "notes": s.notes}
            for s in sorted(a.schedules, key=lambda s: (s.weekday or 0, s.time))
            if s.active and s.kind == "weekly"
        ],
        "upcoming": [
            {"time": dt, "truck": s.truck, "notes": s.notes, "one_time": s.kind == "once"}
            for dt, s in pickups
        ],
    }


class OptOutIn(BaseModel):
    phone: str


@router.post("/opt-out")
def opt_out(body: OptOutIn, db: Session = Depends(get_db)):
    """
    Stop all SMS to a number (Data Privacy Act: residents can withdraw consent).
    The answer is the same whether or not the number was registered, so it can't be used
    to find out who is on the list.
    """
    try:
        phone = normalize_phone(body.phone)
    except InvalidPhone as e:
        raise HTTPException(400, str(e))
    now = datetime.now()
    for c in db.scalars(select(Contact).where(Contact.phone == phone, Contact.active.is_(True))).all():
        c.active, c.opted_out_at = False, now
    db.commit()
    return {"message": "If this number was registered, it will no longer receive TrashWatch SMS."}


@router.get("/info")
def info():
    """Details for the privacy notice, from backend/.env."""
    return {
        "organization": os.getenv("ORG_NAME", ""),
        "privacy_contact": os.getenv("PRIVACY_CONTACT", ""),
        "photo_retention_days": PHOTO_RETENTION_DAYS,
    }
