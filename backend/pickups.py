"""Turns Schedule rows into concrete pickup datetimes."""

from datetime import date, datetime, time, timedelta

from .models import Schedule

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _at(day: date, hhmm: str) -> datetime:
    h, m = map(int, hhmm.split(":"))
    return datetime.combine(day, time(h, m))


def occurrences(s: Schedule, start: datetime, end: datetime) -> list[datetime]:
    """All pickup times of schedule `s` within [start, end]."""
    if not s.active:
        return []
    if s.kind == "once":
        if not s.date:
            return []
        dt = _at(date.fromisoformat(s.date), s.time)
        return [dt] if start <= dt <= end else []
    out = []
    day = start.date()
    while day <= end.date():
        if day.weekday() == s.weekday:
            dt = _at(day, s.time)
            if start <= dt <= end:
                out.append(dt)
        day += timedelta(days=1)
    return out


def upcoming(schedules: list[Schedule], now: datetime, days: int = 14) -> list[tuple[datetime, Schedule]]:
    """Pickups from now until `days` ahead, soonest first."""
    end = now + timedelta(days=days)
    items = [(dt, s) for s in schedules for dt in occurrences(s, now, end)]
    return sorted(items, key=lambda x: x[0])


def describe(s: Schedule) -> str:
    when = f"Every {WEEKDAYS[s.weekday]}" if s.kind == "weekly" and s.weekday is not None else s.date or ""
    return f"{when} at {fmt_time(s.time)}"


def fmt_time(hhmm: str) -> str:
    return datetime.strptime(hhmm, "%H:%M").strftime("%I:%M %p").lstrip("0")
