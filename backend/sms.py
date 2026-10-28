"""
SMS sending through Semaphore (https://semaphore.co), a Philippine SMS gateway.

Set SEMAPHORE_API_KEY (and optionally SEMAPHORE_SENDER_NAME) in backend/.env to send
real messages. Without a key, messages are "simulated": printed to the console and
logged with status 'simulated', so everything else can be tested for free.
"""

import os
import re

import requests

SEMAPHORE_URL = "https://api.semaphore.co/api/v4/messages"


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
    return "semaphore" if os.getenv("SEMAPHORE_API_KEY") else "simulated"


def send_sms(phone: str, message: str) -> tuple[str, str]:
    """Returns (status, error) where status is 'sent', 'simulated' or 'failed'."""
    api_key = os.getenv("SEMAPHORE_API_KEY")
    if not api_key:
        print(f"[SMS simulated] to {phone}: {message}")
        return "simulated", ""

    data = {"apikey": api_key, "number": phone, "message": message}
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
