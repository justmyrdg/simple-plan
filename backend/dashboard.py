"""Admin dashboard summary and SMS log."""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .auth import current_user
from .db import get_db
from .models import Area, Contact, Detection, SmsLog
from .pickups import upcoming
from .sms import provider_name

router = APIRouter(prefix="/api", tags=["admin"], dependencies=[Depends(current_user)])

# a camera counts as online if it reported within this window
ONLINE_WINDOW = timedelta(minutes=2)


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db)):
    now = datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    areas = db.scalars(select(Area).order_by(Area.name)).all()

    pickups = sorted(
        ((dt, a, s) for a in areas for dt, s in upcoming(a.schedules, now, days=7)),
        key=lambda x: x[0],
    )

    # trash share per hour over the last 24h, across all areas
    since = now - timedelta(hours=24)
    rows = db.execute(
        select(Detection.created_at, Detection.status).where(Detection.created_at >= since)
    ).all()
    buckets = []
    for h in range(24, 0, -1):
        start = (now - timedelta(hours=h)).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        end = start + timedelta(hours=1)
        in_bucket = [st for t, st in rows if start <= t < end]
        buckets.append({
            "hour": start,
            "checks": len(in_bucket),
            "trash": sum(1 for st in in_bucket if st == "trash"),
        })

    sms_today = db.execute(
        select(SmsLog.status, func.count()).where(SmsLog.created_at >= today).group_by(SmsLog.status)
    ).all()

    return {
        "sms_provider": provider_name(),
        "totals": {
            "areas": len(areas),
            "cameras": sum(1 for a in areas if a.camera_enabled),
            "cameras_online": sum(
                1 for a in areas if a.camera_enabled and a.last_checked_at and now - a.last_checked_at <= ONLINE_WINDOW
            ),
            "areas_trash": sum(1 for a in areas if a.last_status == "trash"),
            "contacts": db.scalar(select(func.count()).select_from(Contact)) or 0,
            "pickups_today": sum(1 for dt, _, _ in pickups if dt.date() == now.date()),
            "sms_today": {status: n for status, n in sms_today},
        },
        "areas": [
            {
                "id": a.id, "name": a.name, "lat": a.lat, "lng": a.lng,
                "camera_enabled": a.camera_enabled,
                "status": a.last_status, "score": a.last_score, "checked_at": a.last_checked_at,
                "online": bool(a.last_checked_at and now - a.last_checked_at <= ONLINE_WINDOW),
            }
            for a in areas
        ],
        "upcoming_pickups": [
            {"time": dt, "area_id": a.id, "area": a.name, "truck": s.truck,
             "contacts": sum(1 for c in a.contacts if c.active)}
            for dt, a, s in pickups[:10]
        ],
        "activity": buckets,
        "recent_detections": [
            {"time": d.created_at, "area": d_area, "status": d.status, "score": d.score}
            for d, d_area in db.execute(
                select(Detection, Area.name).join(Area, Area.id == Detection.area_id)
                .order_by(Detection.created_at.desc()).limit(8)
            ).all()
        ],
    }


@router.get("/sms-log")
def sms_log(area_id: int | None = None, limit: int = 100, db: Session = Depends(get_db)):
    q = select(SmsLog, Area.name).outerjoin(Area, Area.id == SmsLog.area_id).order_by(SmsLog.created_at.desc())
    if area_id:
        q = q.where(SmsLog.area_id == area_id)
    rows = db.execute(q.limit(max(1, min(limit, 500)))).all()
    return [
        {"id": s.id, "time": s.created_at, "area": name, "phone": s.phone, "message": s.message,
         "status": s.status, "error": s.error, "kind": s.kind}
        for s, name in rows
    ]
