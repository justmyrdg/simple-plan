"""
Collection performance report: the numbers that show whether waste management is improving.

Per area, over the last N days:
  collection rate        collected / (collected + missed)   (pickups where there was waste and the camera watched)
  on-time rate           collected within COLLECTION_LATE_MINUTES of the scheduled time
  avg delay              minutes between the scheduled time and the area turning clean
  avg hours full         how long the area stayed full before it was collected
  time full              share of the camera-observed time the area looked full
  times filled up        how often the area went from clean to full
  reminders sent / failed
"""

import csv
import io
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .auth import current_user
from .collection_tracker import STALE, list_collections
from .db import get_db
from .models import Area, Detection, SmsLog

router = APIRouter(prefix="/api/reports", tags=["reports"], dependencies=[Depends(current_user)])


def _ratio(a: int, b: int) -> float | None:
    return round(a / b, 4) if b else None


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _time_full(db: Session, area_id: int, since: datetime, until: datetime) -> tuple[float, float, int]:
    """(hours observed, hours full, times it filled up) from the detection history."""
    rows = db.execute(
        select(Detection.created_at, Detection.status)
        .where(Detection.area_id == area_id, Detection.created_at >= since, Detection.created_at <= until)
        .order_by(Detection.created_at)
    ).all()
    observed = full = 0.0
    filled = 0
    for i, (t, status) in enumerate(rows):
        nxt = rows[i + 1][0] if i + 1 < len(rows) else until
        # a long gap means the camera was off; count at most STALE of it
        span = min(nxt - t, STALE).total_seconds() / 3600
        observed += span
        if status == "trash":
            full += span
            if i > 0 and rows[i - 1][1] == "clean":
                filled += 1
    return observed, full, filled


def build_report(db: Session, days: int) -> dict:
    until = datetime.now()
    since = until - timedelta(days=days)
    collections = [c for c in list_collections(db, since, until) if c["status"] != "pending"]
    areas = db.scalars(select(Area).order_by(Area.name)).all()
    sms = db.execute(
        select(SmsLog.area_id, SmsLog.status, func.count()).where(
            SmsLog.kind == "reminder", SmsLog.created_at >= since
        ).group_by(SmsLog.area_id, SmsLog.status)
    ).all()

    def summarize(cs: list[dict], observed: float, full: float, filled: int, sent: int, failed: int) -> dict:
        count = {s: sum(1 for c in cs if c["status"] == s) for s in ("collected", "missed", "no_waste", "no_data")}
        collected = [c for c in cs if c["status"] == "collected"]
        return {
            "pickups": len(cs),
            **count,
            "collection_rate": _ratio(count["collected"], count["collected"] + count["missed"]),
            "on_time_rate": _ratio(sum(1 for c in collected if c["on_time"]), len(collected)),
            "avg_minutes_late": _mean([c["minutes_from_schedule"] for c in collected]),
            "avg_hours_full": _mean([c["hours_full"] for c in collected if c["hours_full"] is not None]),
            "time_full": _ratio(round(full * 100), round(observed * 100)) if observed else None,
            "hours_observed": round(observed, 1),
            "times_filled": filled,
            "reminders_sent": sent,
            "reminders_failed": failed,
        }

    rows, totals = [], {"observed": 0.0, "full": 0.0, "filled": 0, "sent": 0, "failed": 0}
    for a in areas:
        observed, full, filled = _time_full(db, a.id, since, until)
        sent = sum(n for aid, st, n in sms if aid == a.id and st in ("sent", "simulated"))
        failed = sum(n for aid, st, n in sms if aid == a.id and st == "failed")
        for k, v in zip(totals, (observed, full, filled, sent, failed)):
            totals[k] += v
        rows.append({"area_id": a.id, "area": a.name,
                     **summarize([c for c in collections if c["area_id"] == a.id], observed, full, filled, sent, failed)})
    return {
        "days": days, "since": since, "until": until,
        "totals": summarize(collections, totals["observed"], totals["full"], totals["filled"], totals["sent"], totals["failed"]),
        "areas": rows,
        "collections": collections[:200],
    }


@router.get("/summary")
def report_summary(days: int = 30, db: Session = Depends(get_db)):
    return build_report(db, max(1, min(days, 366)))


@router.get("/collections.csv")
def report_csv(days: int = 30, db: Session = Depends(get_db)):
    """Every judged pickup in the period, one row each, for spreadsheets."""
    days = max(1, min(days, 366))
    data = [c for c in list_collections(db, datetime.now() - timedelta(days=days)) if c["status"] != "pending"]
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["area", "scheduled_for", "status", "full_since", "collected_at", "minutes_from_schedule", "on_time", "hours_full"])
    for c in reversed(data):
        w.writerow([c["area"], c["scheduled_for"], c["status"], c["full_since"] or "", c["collected_at"] or "",
                    "" if c["minutes_from_schedule"] is None else c["minutes_from_schedule"],
                    c["on_time"] if c["status"] == "collected" else "", "" if c["hours_full"] is None else c["hours_full"]])
    return Response(out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="trashwatch-collections-{days}d.csv"'})
