"""
TrashWatch site agent.

Runs on any computer on the same network as the cameras (a laptop, mini PC or
Raspberry Pi) and sends a photo from each camera to the TrashWatch server,
which can be on this network or in the cloud (e.g. EC2). The server never has
to reach the cameras, so no port forwarding or VPN is needed.

Cameras are found by MAC address or serial number with Hikvision's SADP
discovery, so a camera whose IP address changes (DHCP) is found again
automatically.

Usage (from the agent/ folder):
    python site_agent.py discover                  # list cameras on this network
    python site_agent.py run                       # check every camera forever
    python site_agent.py run --once                # one round, for testing
    python site_agent.py run --config other.json

Settings are in agent.json (copy agent.example.json).
"""

import argparse
import json
import os
import re
import socket
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

# RTSP over TCP: UDP drops packets on busy Wi-Fi and gives smeared frames
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

import cv2  # noqa: E402
import requests  # noqa: E402

HERE = Path(__file__).resolve().parent
SADP_GROUP, SADP_PORT = "239.255.255.250", 37020
UPLOAD_MAX_WIDTH = 1280


def log(msg: str):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def norm_mac(mac: str) -> str:
    """'84-94-59-C3-DF-54' / '84:94:59:c3:df:54' -> '84:94:59:c3:df:54'"""
    return ":".join(re.findall(r"[0-9a-f]{2}", mac.lower()))


# ---------- discovery ----------

def _local_ips() -> set[str]:
    ips = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    try:
        # the address of the default route; on Linux the hostname often resolves to 127.0.1.1
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    return {ip for ip in ips if not ip.startswith("127.")}


def _tag(xml: str, name: str) -> str:
    m = re.search(rf"<{name}>(.*?)</{name}>", xml, re.S)
    return m.group(1).strip() if m else ""


def discover(timeout: float = 3) -> list[dict]:
    """Find Hikvision devices with a SADP probe on every network interface."""
    probe = (f'<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>{str(uuid.uuid4()).upper()}</Uuid>'
             "<Types>inquiry</Types></Probe>").encode()
    socks = []
    # some devices answer to the multicast group, others straight to the sender
    try:
        rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        rx.bind(("", SADP_PORT))
        socks.append(rx)
    except OSError:
        rx = None
    for ip in _local_ips():
        try:
            if rx:
                rx.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, socket.inet_aton(SADP_GROUP) + socket.inet_aton(ip))
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ip))
            s.bind((ip, 0))
            s.sendto(probe, (SADP_GROUP, SADP_PORT))
            socks.append(s)
        except OSError:
            continue
    for s in socks:
        s.settimeout(0.2)

    found: dict[str, dict] = {}
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        for s in socks:
            try:
                data, _ = s.recvfrom(65535)
            except OSError:
                continue
            xml = data.decode(errors="replace")
            if "<ProbeMatch>" not in xml or not _tag(xml, "MAC"):
                continue
            mac = norm_mac(_tag(xml, "MAC"))
            found[mac] = {
                "ip": _tag(xml, "IPv4Address"),
                "mac": mac,
                "serial": _tag(xml, "DeviceSN"),
                "model": _tag(xml, "DeviceDescription"),
                "dhcp": _tag(xml, "DHCP") == "true",
            }
    for s in socks:
        s.close()
    return list(found.values())


# ---------- cameras ----------

def rtsp_url(cam: dict, ip: str) -> str:
    user = quote(cam.get("username", "admin"), safe="")
    pw = quote(cam.get("password", ""), safe="")
    return f"rtsp://{user}:{pw}@{ip}:{cam.get('port', 554)}{cam.get('path', '/Streaming/Channels/101')}"


def grab_frame(url: str):
    """One fresh frame, or None if the camera can't be reached."""
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG, [
        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000,
        cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000,
    ])
    try:
        if not cap.isOpened():
            return None
        frame = None
        for _ in range(3):  # the first decoded frame can be half-drawn
            ok, f = cap.read()
            if ok:
                frame = f
        return frame
    finally:
        cap.release()


def to_jpeg(frame) -> bytes:
    h, w = frame.shape[:2]
    if w > UPLOAD_MAX_WIDTH:
        frame = cv2.resize(frame, (UPLOAD_MAX_WIDTH, round(h * UPLOAD_MAX_WIDTH / w)), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


def cam_name(cam: dict) -> str:
    return cam.get("name") or f"area {cam['area_id']}"


# ---------- server ----------

class Server:
    def __init__(self, cfg: dict):
        self.url = cfg["server"].rstrip("/")
        self.username, self.password = cfg["username"], cfg["password"]
        self.token: str | None = None

    def login(self):
        r = requests.post(f"{self.url}/api/auth/login", json={"username": self.username, "password": self.password}, timeout=30)
        if r.status_code == 401:
            raise SystemExit("Server login failed: wrong username or password in agent.json")
        r.raise_for_status()
        self.token = r.json()["token"]

    def detect(self, area_id: int, jpg: bytes, threshold: float, grid: int) -> dict:
        for attempt in range(2):
            if self.token is None:
                self.login()
            r = requests.post(
                f"{self.url}/api/detect",
                headers={"Authorization": f"Bearer {self.token}"},
                files={"file": ("frame.jpg", jpg, "image/jpeg")},
                data={"threshold": threshold, "grid": grid, "area_id": area_id, "source": "live"},
                timeout=120,
            )
            if r.status_code == 401 and attempt == 0:  # token expired: log in again
                self.token = None
                continue
            if r.status_code >= 400:
                raise RuntimeError(r.json().get("detail", f"HTTP {r.status_code}"))
            return r.json()
        raise RuntimeError("not logged in")


# ---------- main loop ----------

class Agent:
    def __init__(self, cfg: dict, state_path: Path):
        self.cfg = cfg
        self.server = Server(cfg)
        self.state_path = state_path
        try:
            self.known_ips: dict[str, str] = json.loads(state_path.read_text())
        except (OSError, ValueError):
            self.known_ips = {}

    def _save_state(self):
        try:
            self.state_path.write_text(json.dumps(self.known_ips, indent=2))
        except OSError:
            pass

    @staticmethod
    def _key(cam: dict) -> str:
        return str(cam["area_id"])

    def _find(self, cam: dict, devices: list[dict]) -> str | None:
        mac, serial = norm_mac(cam.get("mac", "")), cam.get("serial", "").strip()
        for d in devices:
            if (mac and d["mac"] == mac) or (serial and d["serial"] == serial):
                return d["ip"]
        return None

    def check_round(self):
        devices: list[dict] | None = None  # discovered at most once per round, only when needed
        for cam in self.cfg["cameras"]:
            key = self._key(cam)
            ip = self.known_ips.get(key) or cam.get("ip")
            frame = grab_frame(rtsp_url(cam, ip)) if ip else None

            if frame is None and (cam.get("mac") or cam.get("serial")):
                if devices is None:
                    devices = discover()
                new_ip = self._find(cam, devices)
                if new_ip is None:
                    log(f"{cam_name(cam)}: camera not found on the network (check its power and cable)")
                    continue
                if new_ip != ip:
                    log(f"{cam_name(cam)}: camera found at {new_ip}" + (f" (was {ip})" if ip else ""))
                    ip = new_ip
                    frame = grab_frame(rtsp_url(cam, ip))

            if frame is None:
                log(f"{cam_name(cam)}: cannot read video from {ip or 'camera'} (check the username, password and path)")
                continue
            if self.known_ips.get(key) != ip:
                self.known_ips[key] = ip
                self._save_state()

            try:
                r = self.server.detect(cam["area_id"], to_jpeg(frame),
                                       self.cfg.get("threshold", 0.5), self.cfg.get("grid", 3))
                log(f"{cam_name(cam)}: {'TRASH' if r['is_trash'] else 'clean'} ({r['score']:.0%})")
            except (requests.RequestException, RuntimeError) as e:
                log(f"{cam_name(cam)}: could not send to the server: {e}")

    def run(self, once: bool = False):
        interval = float(self.cfg.get("interval_seconds", 30))
        log(f"Sending {len(self.cfg['cameras'])} camera(s) to {self.server.url} every {interval:g} s")
        while True:
            started = time.monotonic()
            self.check_round()
            if once:
                return
            time.sleep(max(1.0, interval - (time.monotonic() - started)))


def load_config(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"{path.name} not found. Copy agent.example.json to {path.name} and fill it in.")
    cfg = json.loads(path.read_text())
    for k in ("server", "username", "password", "cameras"):
        if k not in cfg:
            raise SystemExit(f"{path.name} is missing '{k}'")
    for cam in cfg["cameras"]:
        if "area_id" not in cam:
            raise SystemExit(f"{path.name}: every camera needs an 'area_id'")
        if not (cam.get("mac") or cam.get("serial") or cam.get("ip")):
            raise SystemExit(f"{path.name}: camera for area {cam['area_id']} needs a 'mac', 'serial' or 'ip'")
    return cfg


def main():
    ap = argparse.ArgumentParser(description="TrashWatch site agent")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("discover", help="list Hikvision cameras on this network")
    run = sub.add_parser("run", help="send camera photos to the server")
    run.add_argument("--config", default=str(HERE / "agent.json"))
    run.add_argument("--once", action="store_true", help="check every camera once and exit")
    args = ap.parse_args()

    if args.cmd == "discover":
        devices = discover()
        if not devices:
            print("No Hikvision cameras found. Check that this computer is on the same network as the cameras.")
            return
        print(f"{'IP address':<16} {'MAC':<18} {'Model':<18} {'DHCP':<5} Serial")
        for d in sorted(devices, key=lambda d: d["ip"]):
            print(f"{d['ip']:<16} {d['mac']:<18} {d['model']:<18} {'yes' if d['dhcp'] else 'no':<5} {d['serial']}")
        print('\nPut the MAC in agent.json, e.g.  "mac": "%s"' % devices[0]["mac"])
        return

    config = Path(args.config)
    agent = Agent(load_config(config), config.with_name("." + config.stem + "_state.json"))
    try:
        agent.run(once=args.once)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
