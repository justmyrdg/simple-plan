"""
SMS sending. Three providers, picked from backend/.env:

  SMS Gateway for Android (free)   SMSGATE_USERNAME + SMSGATE_PASSWORD
      An Android phone with a SIM sends the texts (https://sms-gate.app). Only the
      phone's load is paid, e.g. an unlimited-text promo.
  Semaphore (paid, PH gateway)     SEMAPHORE_API_KEY (+ optional SEMAPHORE_SENDER_NAME)
  simulated                        neither set: messages are printed and logged, nothing is sent

SMS_PROVIDER=smsgate|semaphore|simulated forces one when both are configured.
Message texts live here too, in English and Filipino (contact.language).
"""

import os
import re
from datetime import datetime

import requests

SEMAPHORE_URL = "https://api.semaphore.co/api/v4/messages"
SMSGATE_URL_DEFAULT = "https://api.sms-gate.app/3rdparty/v1/messages"
LANGUAGES = ("en", "fil")


class InvalidPhone(ValueError):
    pass


def normalize_phone(raw: str) -> str:
    """Accepts 09XXXXXXXXX, 9XXXXXXXXX, 639XXXXXXXXX, +639XXXXXXXXX (spaces/dashes ok) -> 09XXXXXXXXX."""
    digits = re.sub(r"[\s\-()]", "", raw or "")
    if digits.startswith("+"):
        digits = digits[1:]
    if digits.startswith("63"):
        digits = "0" + digits[2:]
    elif digits.startswith("9") and len(digits) == 10:
        digits = "0" + digits
    if not re.fullmatch(r"09\d{9}", digits):
        raise InvalidPhone("Enter a Philippine mobile number like 09171234567")
    return digits


def provider_name() -> str:
    forced = os.getenv("SMS_PROVIDER", "").strip().lower()
    if forced in ("smsgate", "semaphore", "simulated"):
        return forced
    if os.getenv("SMSGATE_USERNAME") and os.getenv("SMSGATE_PASSWORD"):
        return "smsgate"
    if os.getenv("SEMAPHORE_API_KEY"):
        return "semaphore"
    return "simulated"


def send_sms(phone: str, message: str) -> tuple[str, str]:
    """Returns (status, error) where status is 'sent', 'simulated' or 'failed'."""
    provider = provider_name()
    if provider == "smsgate":
        return _send_smsgate(phone, message)
    if provider == "semaphore":
        return _send_semaphore(phone, message)
    print(f"[SMS simulated] to {phone}: {message}")
    return "simulated", ""


def _send_semaphore(phone: str, message: str) -> tuple[str, str]:
    data = {"apikey": os.getenv("SEMAPHORE_API_KEY", ""), "number": phone, "message": message}
    if os.getenv("SEMAPHORE_SENDER_NAME"):
        data["sendername"] = os.environ["SEMAPHORE_SENDER_NAME"]
    try:
        r = requests.post(SEMAPHORE_URL, data=data, timeout=20)
    except requests.RequestException as e:
        return "failed", f"Network error: {e}"
    # success is a JSON list of queued messages; errors come back as an object
    try:
        body = r.json()
    except ValueError:
        body = r.text
    if r.ok and isinstance(body, list):
        return "sent", ""
    return "failed", f"HTTP {r.status_code}: {str(body)[:300]}"


def _send_smsgate(phone: str, message: str) -> tuple[str, str]:
    # the gateway wants E.164 numbers: 09171234567 -> +639171234567
    e164 = "+63" + phone[1:] if phone.startswith("0") else phone
    url = os.getenv("SMSGATE_URL", SMSGATE_URL_DEFAULT)
    try:
        r = requests.post(
            url,
            auth=(os.getenv("SMSGATE_USERNAME", ""), os.getenv("SMSGATE_PASSWORD", "")),
            json={"textMessage": {"text": message}, "phoneNumbers": [e164]},
            timeout=20,
        )
    except requests.RequestException as e:
        return "failed", f"Network error: {e}"
    # 2xx means the phone accepted it for sending
    if r.ok:
        return "sent", ""
    return "failed", f"HTTP {r.status_code}: {r.text[:300]}"


# ---------- message texts ----------

_FIL_DAYS = ["Lunes", "Martes", "Miyerkules", "Huwebes", "Biyernes", "Sabado", "Linggo"]
_FIL_MONTHS = ["Ene", "Peb", "Mar", "Abr", "May", "Hun", "Hul", "Ago", "Set", "Okt", "Nob", "Dis"]


def _time(dt: datetime) -> str:
    return dt.strftime("%I:%M %p").lstrip("0")


def _day(dt: datetime, now: datetime, lang: str) -> str:
    delta = (dt.date() - now.date()).days
    if lang == "fil":
        if delta == 0:
            return "ngayong araw"
        if delta == 1:
            return "bukas"
        return f"sa {_FIL_DAYS[dt.weekday()]}, {_FIL_MONTHS[dt.month - 1]} {dt.day}"
    if delta == 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    return dt.strftime("on %a %b %d").replace(" 0", " ")


def _stop_hint(lang: str) -> str:
    """Opt-out instructions, only when the public site address is known."""
    url = os.getenv("PUBLIC_URL", "").rstrip("/")
    if not url:
        return ""
    return f" Para huminto: {url}/stop" if lang == "fil" else f" To stop: {url}/stop"


def reminder_text(lang: str, area: str, pickup: datetime, now: datetime, truck: str = "", notes: str = "") -> str:
    if lang == "fil":
        msg = (f"TrashWatch: Darating ang trak ng basura sa {area} {_day(pickup, now, lang)} "
               f"ng {_time(pickup)}. Pakilabas na po ang inyong basura.")
        if truck:
            msg += f" Trak: {truck}."
    else:
        msg = (f"TrashWatch: Garbage truck pickup at {area} {_day(pickup, now, lang)} "
               f"at {_time(pickup)}. Please bring out your trash.")
        if truck:
            msg += f" Truck: {truck}."
    if notes:
        msg += f" {notes}"
    return msg + _stop_hint(lang)


def test_text(lang: str, name: str, area: str) -> str:
    if lang == "fil":
        return (f"TrashWatch: Kumusta {name}, ito ay test na mensahe. Makakatanggap ka ng paalala "
                f"bago kunin ang basura sa {area}.") + _stop_hint(lang)
    return (f"TrashWatch: Hi {name}, this is a test message. You'll get pickup reminders "
            f"for {area}.") + _stop_hint(lang)
