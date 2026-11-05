from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class User(Base):
    """Admin account that can log in to the dashboard."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Area(Base):
    """A monitored place, optionally with a camera."""

    __tablename__ = "areas"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str] = mapped_column(String(255), default="")
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    camera_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    camera_label: Mapped[str] = mapped_column(String(120), default="")
    # network camera address (RTSP etc.); empty = frames come from a browser on the Monitor page
    camera_url: Mapped[str] = mapped_column(String(500), default="")
    # saved zoom: the part of the frame the detector looks at, as fractions of the frame (see viewport.py)
    view_x: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    view_y: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    view_w: Mapped[float] = mapped_column(Float, default=1.0, server_default="1")
    view_h: Mapped[float] = mapped_column(Float, default=1.0, server_default="1")

    # latest detection, updated by /api/detect
    last_status: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 'trash' | 'clean'
    last_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # set by collection_tracker when a scheduled pickup is confirmed collected
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    contacts: Mapped[list["Contact"]] = relationship(back_populates="area", cascade="all, delete-orphan")
    schedules: Mapped[list["Schedule"]] = relationship(back_populates="area", cascade="all, delete-orphan")


class Contact(Base):
    """A resident's phone number that receives pickup SMS for one area."""

    __tablename__ = "contacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("areas.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(20))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    language: Mapped[str] = mapped_column(String(3), default="en")  # 'en' | 'fil' (Filipino)
    # Data Privacy Act (RA 10173): when the resident agreed to receive SMS
    consent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    opted_out_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    area: Mapped[Area] = relationship(back_populates="contacts")

    __table_args__ = (UniqueConstraint("area_id", "phone", name="uq_contact_area_phone"),)


class Schedule(Base):
    """
    A garbage truck pickup.
    kind='weekly' repeats on `weekday` (0=Mon..6=Sun); kind='once' happens on `date` (YYYY-MM-DD).
    """

    __tablename__ = "schedules"

    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("areas.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10), default="weekly")
    weekday: Mapped[int | None] = mapped_column(Integer, nullable=True)
    date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    time: Mapped[str] = mapped_column(String(5))  # HH:MM, 24h
    truck: Mapped[str] = mapped_column(String(120), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    notify_minutes_before: Mapped[int] = mapped_column(Integer, default=60)
    # also text residents at the pickup time itself, not only before it
    notify_at_pickup: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    area: Mapped[Area] = relationship(back_populates="schedules")


class Detection(Base):
    """Detection history per area. Written when status changes or at most once a minute."""

    __tablename__ = "detections"

    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("areas.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16))
    score: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(16), default="live")  # 'live' | 'upload'
    # camera frame saved when the status changed (proof for collections), in backend/captures/
    photo: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, index=True)


class Snapshot(Base):
    """A photo an admin saved by hand from an area's network camera. The file is <id>.jpg in storage 'snapshots'."""

    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("areas.id", ondelete="CASCADE"), index=True)
    taken_by: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, index=True)


class Recording(Base):
    """
    A video an admin recorded by hand from an area's network camera (no audio). The file is <id>.mp4
    in storage 'recordings'. status: 'recording' | 'done' | 'failed'.
    """

    __tablename__ = "recordings"

    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("areas.id", ondelete="CASCADE"), index=True)
    started_by: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(16), default="recording")
    error: Mapped[str] = mapped_column(Text, default="")
    size: Mapped[int] = mapped_column(Integer, default=0)  # bytes
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, index=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class RecordingResult(Base):
    """The detector's verdict at one moment of a recording; `offset` is seconds from the start of the video."""

    __tablename__ = "recording_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    recording_id: Mapped[int] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"), index=True)
    offset: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(16))  # 'trash' | 'clean'
    score: Mapped[float] = mapped_column(Float)
    cells: Mapped[str] = mapped_column(Text, default="")  # JSON grid of per-region scores, "" when the grid was off
    threshold: Mapped[float] = mapped_column(Float, default=0.5)  # the trash threshold the verdict and shading used


class Collection(Base):
    """
    What happened at one scheduled pickup, judged from the camera history around it:
    'pending'   window still open, nothing decided yet
    'collected' the area went from full to clean in the window
    'missed'    the area was still full when the window closed
    'no_waste'  the area was never full in the window (nothing to collect)
    'no_data'   the camera wasn't reporting, so it can't be judged
    """

    __tablename__ = "collections"

    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("areas.id", ondelete="CASCADE"), index=True)
    schedule_id: Mapped[int | None] = mapped_column(ForeignKey("schedules.id", ondelete="SET NULL"), nullable=True)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime, index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    full_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    collected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    before_detection_id: Mapped[int | None] = mapped_column(ForeignKey("detections.id", ondelete="SET NULL"), nullable=True)
    after_detection_id: Mapped[int | None] = mapped_column(ForeignKey("detections.id", ondelete="SET NULL"), nullable=True)
    alerted: Mapped[bool] = mapped_column(Boolean, default=False)  # admin SMS sent for a miss
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    __table_args__ = (UniqueConstraint("area_id", "scheduled_for", name="uq_collection_area_time"),)


class SmsLog(Base):
    """Every SMS attempt. (schedule_id, occurrence, phone) stops duplicate reminders."""

    __tablename__ = "sms_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int | None] = mapped_column(ForeignKey("areas.id", ondelete="SET NULL"), nullable=True, index=True)
    contact_id: Mapped[int | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    schedule_id: Mapped[int | None] = mapped_column(ForeignKey("schedules.id", ondelete="SET NULL"), nullable=True)
    occurrence: Mapped[str | None] = mapped_column(String(16), nullable=True)  # pickup date YYYY-MM-DD
    phone: Mapped[str] = mapped_column(String(20))
    message: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))  # 'sent' | 'simulated' | 'failed'
    error: Mapped[str] = mapped_column(Text, default="")
    # 'reminder' (before pickup) | 'at_pickup' (at pickup time) | 'manual' | 'alert' (to admins)
    kind: Mapped[str] = mapped_column(String(16), default="reminder")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, index=True)
