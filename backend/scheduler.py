"""
Background loop, every minute:
  - texts each area's contacts before a scheduled pickup (in each contact's language)
  - judges scheduled pickups from the camera history (collection_tracker)
  - deletes camera photos older than PHOTO_RETENTION_DAYS (Data Privacy Act: keep only what's needed)
"""

import asyncio
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .collection_tracker import cleanup_photos, update_collections
from .db import SessionLocal
from .models import Contact, Schedule, SmsLog
from .pickups import occurrences
from .sms import reminder_text, send_sms

CHECK_EVERY_SECONDS = 60


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
            for c in contacts:
                if c.phone in already:
                    continue
                text = reminder_text(c.language, s.area.name, pickup, now, s.truck, s.notes)
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
        sent = send_due_reminders(db)
        decided = update_collections(db)
        cleanup_photos(db)
        return sent, decided


async def reminder_loop():
    while True:
        try:
            sent, decided = await asyncio.to_thread(_tick)
            if sent:
                print(f"[scheduler] sent {sent} pickup reminder(s)")
            for line in decided:
                print(f"[collection] {line}")
        except Exception as e:  # keep the loop alive no matter what
            print(f"[scheduler] error: {e!r}")
        await asyncio.sleep(CHECK_EVERY_SECONDS)
