"""Background loop that texts each area's contacts before a scheduled pickup."""

import asyncio
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Contact, Schedule, SmsLog
from .pickups import fmt_time, occurrences
from .sms import send_sms

CHECK_EVERY_SECONDS = 60


def reminder_text(area_name: str, pickup: datetime, s: Schedule, now: datetime) -> str:
    day = "today" if pickup.date() == now.date() else pickup.strftime("%a %b %d")
    msg = f"TrashWatch: Garbage truck pickup at {area_name} {day} at {fmt_time(pickup.strftime('%H:%M'))}."
    msg += " Please bring out your trash."
    if s.truck:
        msg += f" Truck: {s.truck}."
    return msg


def send_due_reminders(db: Session, now: datetime | None = None) -> int:
    """
    For every pickup whose reminder time has passed but whose pickup hasn't happened yet,
    text each active contact once. Catches up if the server was off at the reminder time.
    """
    now = now or datetime.now()
    sent = 0
    schedules = db.scalars(select(Schedule).where(Schedule.active.is_(True))).all()
    for s in schedules:
        window_end = now + timedelta(minutes=s.notify_minutes_before)
        for pickup in occurrences(s, now, window_end):
            occurrence = pickup.date().isoformat()
            contacts = db.scalars(
                select(Contact).where(Contact.area_id == s.area_id, Contact.active.is_(True))
            ).all()
            already = set(
                db.scalars(
                    select(SmsLog.phone).where(
                        SmsLog.schedule_id == s.id,
                        SmsLog.occurrence == occurrence,
                        SmsLog.kind == "reminder",
                        SmsLog.status != "failed",
                    )
                ).all()
            )
            text = reminder_text(s.area.name, pickup, s, now)
            for c in contacts:
                if c.phone in already:
                    continue
                status, error = send_sms(c.phone, text)
                db.add(SmsLog(
                    area_id=s.area_id, contact_id=c.id, schedule_id=s.id, occurrence=occurrence,
                    phone=c.phone, message=text, status=status, error=error, kind="reminder",
                ))
                db.commit()
                sent += 1
    return sent


def _tick():
    with SessionLocal() as db:
        return send_due_reminders(db)


async def reminder_loop():
    while True:
        try:
            n = await asyncio.to_thread(_tick)
            if n:
                print(f"[scheduler] sent {n} pickup reminder(s)")
        except Exception as e:  # keep the loop alive no matter what
            print(f"[scheduler] error: {e!r}")
        await asyncio.sleep(CHECK_EVERY_SECONDS)
