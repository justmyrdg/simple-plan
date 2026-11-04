# Live camera feed on EC2

How to let the EC2 server read an IP camera that sits on a private network (home or site LAN). The backend only needs a reachable RTSP address in the area's **camera address** field (`Area.camera_url`). Everything else (Monitor page stream, `camera_watch_loop`, collection tracking) works the same as for a camera on the local network.

> Commands below were written from memory and not tested on this setup. Check each one against your router and Tailscale versions.

Pick one route:

| | A. Router port forward | B. Tailscale port forward |
|---|---|---|
| Needs | Real public IP (no CGNAT) | An always-on device on the camera LAN |
| Camera exposed to internet | Yes | No |
| Encrypted | No (plain RTSP) | Yes |
| Works behind CGNAT | No | Yes |

---

## A. Router port forward (camera → router → EC2)

### 1. Check that your router can be reached
- [ ] Open the router's status page and note its WAN IP.
- [ ] Compare with the IP shown by a "what's my IP" site. If they differ, the ISP uses CGNAT and this route will not work. Use route B, or ask the ISP for a public IP.

### 2. Prepare the camera
- [ ] Give the camera a fixed LAN IP (DHCP reservation on the router, or static on the camera). Example: `192.168.254.64`.
- [ ] Update the camera firmware.
- [ ] Set a strong, unique admin password.
- [ ] Turn off UPnP on the camera and the router.
- [ ] Confirm the stream works on the LAN first: `$env:CAMERA_PASSWORD = "..." ; python index.py`.

### 3. Get a stable address
- [ ] Set up a DDNS hostname (DuckDNS, No-IP, or the router's built-in client) pointing at the router's WAN IP.
- [ ] Attach an **Elastic IP** to the EC2 instance so its source address never changes.

### 4. Forward the port
- [ ] On the router, add a port forward: external port `38554` (any unused high port) → `192.168.254.64:554`, TCP only.
- [ ] Forward nothing else (not 80, 443, 8000 or the Hikvision SDK port).
- [ ] If the router supports it, restrict the rule to the EC2 Elastic IP as the only allowed source. This is the most important protection.

### 5. Test from EC2
```bash
ssh ubuntu@<ec2>
ffprobe -rtsp_transport tcp "rtsp://admin:<password>@<ddns-host>:38554/Streaming/Channels/101"
```
It should print video stream info. If it hangs, recheck the forward, the source filter, and CGNAT.

### 6. Point the app at it
- [ ] Log in to the site, go to **Areas**, edit the area.
- [ ] Set the camera address to `rtsp://admin:<password>@<ddns-host>:38554/Streaming/Channels/101`.
- [ ] Do **not** also run `agent/site_agent.py` for this area, since both would write its status.
- [ ] Open **Monitor**, select the area, and choose "Network camera". The MJPEG stream should appear.
- [ ] Check that the dashboard shows the camera online (a check within the last 2 minutes).

### Risks to accept
- RTSP is unencrypted, so video and credentials can be read on the path.
- The password is stored in `Area.camera_url` in the SQLite DB.
- An open RTSP port on a Hikvision camera is scanned constantly. Keep the source filter and firmware current.

---

## B. Tailscale port forward (no subnet router, nothing exposed)

A device on the camera LAN (laptop, ideally a Raspberry Pi or mini PC) forwards one port to the camera over the tailnet.

### 1. Install Tailscale
- [ ] Install on the LAN device and log in.
- [ ] Install on EC2 (`curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`) using the same account.
- [ ] No `--advertise-routes` or `--accept-routes` needed.

### 2. Forward the camera's RTSP port from the LAN device
```bash
tailscale serve --tcp 554 tcp://192.168.254.64:554
```
Replace the IP with the camera's. Check with `tailscale serve status`.

### 3. Test from EC2
```bash
ffprobe -rtsp_transport tcp "rtsp://admin:<password>@<device-tailnet-name>:554/Streaming/Channels/101"
```

### 4. Point the app at it
Same as step 6 of route A, with the camera address `rtsp://admin:<password>@<device-tailnet-name>:554/Streaming/Channels/101`.

### Alternative if `tailscale serve --tcp` doesn't work
Run [MediaMTX](https://github.com/bluenviron/mediamtx) on the LAN device with the camera as its source, and use `rtsp://<device-tailnet-name>:8554/cam` as the camera address.

### Notes
- The LAN device must stay on. If it goes down, the area shows offline after 2 minutes and affected pickups are judged `no_data`.
- Tailscale encrypts the link, and the camera is never exposed to the internet.

---

## Not wanting EC2 on the tailnet or an open port?
Use the agent instead (`agent/site_agent.py`, see `CAMERA_SETUP.md`). It posts one frame every 30 s over HTTPS, which is enough for status, SMS and collection tracking but gives no live video.
