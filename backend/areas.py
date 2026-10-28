"""Admin CRUD: areas, their contacts (phone numbers) and pickup schedules."""

import re
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import current_user
from .db import get_db
from .models import Area, Contact, Detection, Schedule, SmsLog
from .pickups import describe, upcoming
from .sms import LANGUAGES, InvalidPhone, normalize_phone, send_sms, test_text

router = APIRouter(prefix="/api", tags=["admin"], dependencies=[Depends(current_user)])


# ---------- schemas ----------

class AreaIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    address: str = ""
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    camera_enabled: bool = True
    camera_label: str = ""
    camera_url: str = Field(default="", max_length=500)

    @field_validator("camera_url")
    @classmethod
    def _camera_url(cls, v: str) -> str:
        v = v.strip()
        if v and not v.isdigit() and not re.match(r"[a-zA-Z][\w+.-]*:", v):
            raise ValueError("camera address must look like rtsp://user:password@192.168.1.64:554/... (or a number for a local camera)")
        return v


class AreaOut(AreaIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    last_status: str | None
    last_score: float | None
    last_checked_at: datetime | None
    last_collected_at: datetime | None = None
    contact_count: int = 0
    schedule_count: int = 0
    next_pickup: datetime | None = None


class ContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str
    active: bool = True
    language: str = "en"
    # the resident agreed to receive SMS (Data Privacy Act); required to add them or to resume after an opt-out
    consent: bool = False

    @field_validator("language")
    @classmethod
    def _language(cls, v: str) -> str:
        if v not in LANGUAGES:
            raise ValueError("language must be 'en' (English) or 'fil' (Filipino)")
        return v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        try:
            return normalize_phone(v)
        except InvalidPhone as e:
            raise ValueError(str(e))


class ContactOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    area_id: int
    name: str
    phone: str
    active: bool
    language: str
    consent_at: datetime | None
    opted_out_at: datetime | None
    created_at: datetime


class ScheduleIn(BaseModel):
    kind: str = "weekly"
    weekday: int | None = Field(default=None, ge=0, le=6)
    date: str | None = None
    time: str
    truck: str = ""
    notes: str = ""
    notify_minutes_before: int = Field(default=60, ge=0, le=60 * 48)
    active: bool = True

    @model_validator(mode="after")
    def _check(self):
        if self.kind not in ("weekly", "once"):
            raise ValueError("kind must be 'weekly' or 'once'")
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", self.time):
            raise ValueError("time must be HH:MM (24-hour)")
        if self.kind == "weekly":
            if self.weekday is None:
                raise ValueError("weekly schedules need a weekday")
            self.date = None
        else:
            try:
                date.fromisoformat(self.date or "")
            except ValueError:
                raise ValueError("one-time schedules need a date (YYYY-MM-DD)")
            self.weekday = None
        return self


class ScheduleOut(ScheduleIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    area_id: int
    description: str = ""


class NotifyIn(BaseModel):
    message: str = Field(min_length=1, max_length=480)


# ---------- helpers ----------

def _area_or_404(db: Session, area_id: int) -> Area:
    area = db.get(Area, area_id)
    if area is None:
        raise HTTPException(404, "Area not found")
    return area


def area_out(db: Session, a: Area, now: datetime | None = None) -> AreaOut:
    now = now or datetime.now()
    nxt = upcoming(a.schedules, now, days=14)
    return AreaOut.model_validate(a).model_copy(update={
        "contact_count": db.scalar(select(func.count()).where(Contact.area_id == a.id)) or 0,
        "schedule_count": len(a.schedules),
        "next_pickup": nxt[0][0] if nxt else None,
    })


def schedule_out(s: Schedule) -> ScheduleOut:
    return ScheduleOut.model_validate(s).model_copy(update={"description": describe(s)})


def _commit_contact(db: Session):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "That phone number is already registered for this area")


# ---------- areas ----------

@router.get("/areas", response_model=list[AreaOut])
def list_areas(db: Session = Depends(get_db)):
    now = datetime.now()
    return [area_out(db, a, now) for a in db.scalars(select(Area).order_by(Area.name)).all()]


@router.post("/areas", response_model=AreaOut, status_code=201)
def create_area(body: AreaIn, db: Session = Depends(get_db)):
    area = Area(**body.model_dump())
    db.add(area)
    db.commit()
    return area_out(db, area)


@router.get("/areas/{area_id}", response_model=AreaOut)
def get_area(area_id: int, db: Session = Depends(get_db)):
    return area_out(db, _area_or_404(db, area_id))


@router.put("/areas/{area_id}", response_model=AreaOut)
def update_area(area_id: int, body: AreaIn, db: Session = Depends(get_db)):
    area = _area_or_404(db, area_id)
    for k, v in body.model_dump().items():
        setattr(area, k, v)
    db.commit()
    return area_out(db, area)


@router.delete("/areas/{area_id}", status_code=204)
def delete_area(area_id: int, db: Session = Depends(get_db)):
    db.delete(_area_or_404(db, area_id))
    db.commit()


@router.get("/areas/{area_id}/detections")
def area_detections(area_id: int, hours: int = 24, db: Session = Depends(get_db)):
    _area_or_404(db, area_id)
    since = datetime.now() - timedelta(hours=max(1, min(hours, 24 * 30)))
    rows = db.scalars(
        select(Detection).where(Detection.area_id == area_id, Detection.created_at >= since).order_by(Detection.created_at)
    ).all()
    return [{"time": d.created_at, "status": d.status, "score": d.score, "source": d.source} for d in rows]


# ---------- contacts ----------

@router.get("/areas/{area_id}/contacts", response_model=list[ContactOut])
def list_contacts(area_id: int, db: Session = Depends(get_db)):
    _area_or_404(db, area_id)
    return db.scalars(select(Contact).where(Contact.area_id == area_id).order_by(Contact.name)).all()


@router.post("/areas/{area_id}/contacts", response_model=ContactOut, status_code=201)
def create_contact(area_id: int, body: ContactIn, db: Session = Depends(get_db)):
    _area_or_404(db, area_id)
    if not body.consent:
        raise HTTPException(400, "Confirm that the resident agreed to receive SMS reminders")
    contact = Contact(area_id=area_id, consent_at=datetime.now(), **body.model_dump(exclude={"consent"}))
    db.add(contact)
    _commit_contact(db)
    return contact


@router.put("/contacts/{contact_id}", response_model=ContactOut)
def update_contact(contact_id: int, body: ContactIn, db: Session = Depends(get_db)):
    contact = db.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(404, "Contact not found")
    if body.active and contact.opted_out_at and not body.consent:
        raise HTTPException(400, "This resident opted out. Turn reminders back on only if they asked again, "
                                 "and confirm their consent.")
    for k, v in body.model_dump(exclude={"consent"}).items():
        setattr(contact, k, v)
    if body.consent:
        contact.consent_at, contact.opted_out_at = datetime.now(), None
    _commit_contact(db)
    return contact


@router.delete("/contacts/{contact_id}", status_code=204)
def delete_contact(contact_id: int, db: Session = Depends(get_db)):
    contact = db.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(404, "Contact not found")
    # erase the person but keep the counts for reports: mask their number and name in the SMS log
    masked = contact.phone[:2] + "•••••" + contact.phone[-4:]
    for log in db.scalars(select(SmsLog).where(SmsLog.contact_id == contact.id)).all():
        log.phone, log.message = masked, log.message.replace(contact.name, "resident")
    db.delete(contact)
    db.commit()


@router.post("/contacts/{contact_id}/test")
def test_contact(contact_id: int, db: Session = Depends(get_db)):
    contact = db.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(404, "Contact not found")
    text = test_text(contact.language, contact.name, contact.area.name)
    status, error = send_sms(contact.phone, text)
    db.add(SmsLog(area_id=contact.area_id, contact_id=contact.id, phone=contact.phone,
                  message=text, status=status, error=error, kind="manual"))
    db.commit()
    return {"status": status, "error": error}


@router.post("/areas/{area_id}/notify")
def notify_area(area_id: int, body: NotifyIn, db: Session = Depends(get_db)):
    """Send a custom message to every active contact of an area right now."""
    area = _area_or_404(db, area_id)
    results = {"sent": 0, "simulated": 0, "failed": 0}
    for c in area.contacts:
        if not c.active:
            continue
        status, error = send_sms(c.phone, body.message)
        results[status] += 1
        db.add(SmsLog(area_id=area.id, contact_id=c.id, phone=c.phone,
                      message=body.message, status=status, error=error, kind="manual"))
    db.commit()
    return results


# ---------- schedules ----------

@router.get("/areas/{area_id}/schedules", response_model=list[ScheduleOut])
def list_schedules(area_id: int, db: Session = Depends(get_db)):
    area = _area_or_404(db, area_id)
    rows = sorted(area.schedules, key=lambda s: (s.kind != "weekly", s.weekday or 0, s.date or "", s.time))
    return [schedule_out(s) for s in rows]


@router.post("/areas/{area_id}/schedules", response_model=ScheduleOut, status_code=201)
def create_schedule(area_id: int, body: ScheduleIn, db: Session = Depends(get_db)):
    _area_or_404(db, area_id)
    s = Schedule(area_id=area_id, **body.model_dump())
    db.add(s)
    db.commit()
    db.refresh(s)
    return schedule_out(s)


@router.put("/schedules/{schedule_id}", response_model=ScheduleOut)
def update_schedule(schedule_id: int, body: ScheduleIn, db: Session = Depends(get_db)):
    s = db.get(Schedule, schedule_id)
    if s is None:
        raise HTTPException(404, "Schedule not found")
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    db.commit()
    return schedule_out(s)


@router.delete("/schedules/{schedule_id}", status_code=204)
def delete_schedule(schedule_id: int, db: Session = Depends(get_db)):
    s = db.get(Schedule, schedule_id)
    if s is None:
        raise HTTPException(404, "Schedule not found")
    db.delete(s)
    db.commit()
