"""Endpoints residents can use without logging in: find an area and see its pickup schedule."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_db
from .models import Area
from .pickups import describe, upcoming

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
