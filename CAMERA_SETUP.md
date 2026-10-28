# TrashWatch Full Setup: IP Camera on the Main Router

This guide sets up everything from start to finish:

1. Give the Hikvision IP camera a fixed IP address with SADP.
2. Move the camera from the laptop cable to the main router.
3. Install and start TrashWatch (backend and frontend).
4. Connect the camera to an area in TrashWatch and check that it works.

---

## Part 0: Network details

| Item | Value |
|---|---|
| Router (gateway) | `192.168.254.254` |
| Subnet mask | `255.255.255.0` |
| Laptop (Wi-Fi) | `192.168.254.100` |
| Camera, old address (direct to laptop) | `169.254.109.94` |
| **Camera, new fixed address** | **`192.168.254.64`** |
| Camera RTSP port | `554` |
| Camera SADP/SDK port | `8000` (camera setting only, not the TrashWatch backend) |

> **Check this first:** open the router's settings page (`http://192.168.254.254`) and find the
> DHCP (automatic address) range. `192.168.254.64` must be **outside** that range, or another device
> could later be given the same address. If it's inside the range, pick a free address outside it
> and use that address everywhere in this guide.

### What you need

- The camera, still plugged into the laptop with its network cable
- The camera's `admin` password (the same one used in `index.py`)
- Power for the camera once it's moved to the router: a PoE injector, a PoE switch, or a 12 V adapter,
  if the laptop cable was powering it
- A spare LAN port on the router (or a switch connected to it)
- The SADP Tool, downloaded from Hikvision's official website
- On the laptop: Python 3.12 and Node.js 22

---

## Part 1: Give the camera a fixed IP address with SADP

1. Install and open **SADP Tool**.
   If no devices appear, close it, right-click it, choose **Run as administrator**,
   and allow it through Windows Firewall when asked.
2. Keep the camera connected to the laptop. SADP lists it with the address `169.254.109.94`
   and the status **Active**.
3. Tick the checkbox next to the camera. The **Modify Network Parameters** panel opens on the right.
4. Fill in the panel:

   | Field | Value |
   |---|---|
   | Enable DHCP | **Off** (unticked) |
   | IPv4 Address | `192.168.254.64` |
   | Subnet Mask | `255.255.255.0` |
   | Gateway | `192.168.254.254` |
   | IPv4 DNS (only shown in some versions) | `192.168.254.254` |
   | Port | leave as `8000` |
   | IPv6 Address / IPv6 Gateway / IPv6 Prefix Length | leave as they are (not used) |

5. Type the camera's admin password in **Admin Password** and click **Modify**.
6. The camera's row in the list should update to `192.168.254.64`.

### Alternative: reserve the address on the router instead

Instead of a fixed address on the camera, you can leave the camera on **DHCP** (automatic addressing)
and have the router always give it the same address. If the camera is ever moved to another
network, it still gets an address there automatically, so it can't get lost.

1. In SADP, tick **Enable DHCP** for the camera and click **Modify** (with the admin password).
2. Open the router's settings page (`http://192.168.254.254`) and log in.
3. Find **DHCP reservation**, also called **Static DHCP**, **Address Reservation** or **DHCP Binding**
   (usually under LAN or DHCP settings).
4. Add a reservation:
   - MAC address: `84:94:59:c3:df:54` (this camera; also shown in SADP)
   - IP address: `192.168.254.64`
5. Save, then restart the camera (unplug its power for 10 seconds).
   SADP should show it at `192.168.254.64` with **DHCP** on.

Either way works. If you use the site agent (Part 7), it finds the camera by its MAC address
even when the address changes, so this matters less.

---

## Part 2: Move the camera to the router

1. Unplug the camera from the laptop.
2. Plug it into one of the router's **LAN** ports (not the WAN/Internet port),
   and power it with PoE or its adapter if needed.
3. Connect the laptop to the router's Wi-Fi.
4. Wait about a minute for the camera to start, then check that it's reachable:
   - In SADP, click **Refresh**. The camera should show `192.168.254.64`.
   - Or open `http://192.168.254.64` in a browser and log in.
5. Optional quick test from the project folder (PowerShell):

   ```powershell
   Test-NetConnection 192.168.254.64 -Port 554
   ```

   `TcpTestSucceeded : True` means the video stream port is open.

---

## Part 3: Install TrashWatch

Do this once, from the project folder (`cam`).

1. Install the Python packages:

   ```powershell
   pip install -r requirements.txt
   ```

2. Install the frontend packages:

   ```powershell
   cd frontend
   npm install
   cd ..
   ```

3. Optional settings: copy `backend\.env.example` to `backend\.env` and edit it.

   | Setting | What it does | Default |
   |---|---|---|
   | `ADMIN_PASSWORD` | Password for the first `admin` login (only used when the database is first created) | `admin123` |
   | `SEMAPHORE_API_KEY` | Sends real SMS through Semaphore. Leave empty to only simulate. | empty |
   | `SEMAPHORE_SENDER_NAME` | Approved sender name on Semaphore | empty |
   | `CAMERA_CHECK_SECONDS` | How often the server checks each network camera by itself (`0` = off) | `30` |
   | `CAMERA_THRESHOLD` | How sure the model must be before an area counts as full of trash | `0.5` |

---

## Part 4: Start TrashWatch

Use two PowerShell windows, both opened in the project folder.

**Window 1: backend (must use port 8000)**

```powershell
python -m uvicorn backend.main:app --port 8000
```

Wait until it prints `Application startup complete.` The first start downloads the AI model (about 600 MB).

**Window 2: frontend**

```powershell
cd frontend
npx ng serve
```

Then open **http://localhost:4200** in a browser.

> Keep both windows open while TrashWatch is in use. The server checks the camera
> only while the backend is running.

---

## Part 5: Connect the camera in TrashWatch

1. Go to **http://localhost:4200/login** and log in.
   The first login is `admin` / `admin123`, unless you set `ADMIN_PASSWORD`.
   Change the password after logging in.
2. Go to **Areas**. Edit the existing **Test Area**, or click **Add area**.
3. Fill in the form:
   - **Area name** and **Address / landmark**
   - Tick **Camera installed at this area**
   - **Camera name**, for example `Camera 1`
   - **Network camera address**:

     ```
     rtsp://admin:<camera password>@192.168.254.64:554/Streaming/Channels/101
     ```

     `Channels/101` is the main stream (2560×1440, more detail).
     `Channels/102` is the sub-stream (640×360, lighter). Use 102 if the laptop's CPU gets too busy.
   - Set the location by clicking the map or dragging the pin.
4. Click **Save area**.
5. Add the residents' phone numbers and the pickup schedule on the area's page, if you haven't already.

---

## Part 6: Check that it works

1. Go to **Monitor** and select the area in the dropdown.
   The source dropdown should say **Network camera**.
2. Click **Start camera**. You should see the live video, the trash score and the region overlay.
3. Go to **Dashboard**. Within about a minute the camera should count as **online**,
   and the area should show **Clean** or **Full of trash**.
4. Close the Monitor page and wait a minute. The area's status keeps updating,
   because the server checks the camera every 30 seconds by itself.
5. If you still use `index.py`, change `CAMERA_IP` in it to `192.168.254.64`.

---

## Part 7: Site agent (for EC2, or cameras on automatic addressing)

Use the site agent when the TrashWatch server is **not on the same network as the camera**,
for example on AWS EC2. A server in the cloud can't reach a camera's private address such as
`192.168.254.64`, so instead a small program on the camera's network sends it a photo every 30 seconds.
No port forwarding or VPN is needed, and it works behind the ISP's CGNAT.

The agent finds each camera by its **MAC address**, so it keeps working even if the camera's
IP address changes.

### What runs where

| Where | What runs |
|---|---|
| A computer on the camera's network (this laptop, a mini PC or a Raspberry Pi) | `agent/site_agent.py` |
| The server (this laptop now, EC2 later) | TrashWatch backend and website |

### Set up the agent

1. On the computer next to the camera, install the agent's packages. It doesn't need the AI model:

   ```powershell
   cd agent
   pip install -r requirements.txt
   ```

2. Find the cameras on the network:

   ```powershell
   python site_agent.py discover
   ```

   ```
   IP address       MAC                Model              DHCP  Serial
   192.168.254.64   84:94:59:c3:df:54  DS-2CD1347G2-L     no    DS-2CD1347G2-L20250818AAWRGE3258971
   ```

3. Copy `agent.example.json` to `agent.json` and fill it in:

   | Setting | Value |
   |---|---|
   | `server` | The TrashWatch backend: `http://localhost:8000` now, or your EC2 address later (use `https://` once it has a domain) |
   | `username` / `password` | A TrashWatch admin login |
   | `interval_seconds` | How often to send a photo (default `30`) |
   | `threshold` / `grid` | Detection settings (defaults `0.5` and `3`) |
   | `cameras[].area_id` | The area's number: open the area in TrashWatch, the URL ends in `/admin/areas/<number>` |
   | `cameras[].mac` | The camera's MAC from `discover` |
   | `cameras[].username` / `password` | The **camera's** login |
   | `cameras[].path` | `/Streaming/Channels/101` (main stream) or `/Streaming/Channels/102` (lighter) |

4. In TrashWatch, open that area and **leave Network camera address empty**.
   The agent sends the photos instead, and the server won't try to connect to the camera itself.
5. Test with one round:

   ```powershell
   python site_agent.py run --once
   ```

   ```
   [2026-10-28 12:18:51] Test Area camera: camera found at 192.168.254.64
   [2026-10-28 12:18:56] Test Area camera: clean (20%)
   ```

6. Run it for real (keep the window open):

   ```powershell
   python site_agent.py run
   ```

The agent remembers each camera's last address in `.agent_state.json`. If the camera stops answering,
it searches the network by MAC address and continues at the new address.

> `agent.json` contains passwords. Keep it only on the agent computer and don't share it.

### Limitation

With the agent, the **Monitor** page can't show live video for that area, because the server never
connects to the camera. The area's status, the Dashboard and the history still update every 30 seconds.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| SADP shows no devices | Run it as administrator, allow it through the firewall, and check the cable and the camera's power. |
| "Wrong password" or the camera is locked | Use the camera's admin password, not the TrashWatch one. After too many wrong tries, wait about 30 minutes for the lock to clear. |
| The camera works in SADP but not in the browser | Make sure the laptop is on the main router's Wi-Fi (`192.168.254.x`). |
| Another device stops working or the camera drops off | `.64` is probably inside the router's DHCP range or already in use. Choose another free address and repeat Part 1. |
| TrashWatch says "Cannot connect to the camera" | Check the address, username and password in the camera address, and that `http://192.168.254.64` opens. |
| Monitor says "Cannot reach the detection server" | The backend isn't running, or it isn't on port 8000. Start it as shown in Part 4. |
| Video is slow or the laptop is very busy | Switch the camera address to `Channels/102`, or set a longer **Check every** on the Monitor page. |
| The dashboard shows the camera offline | The backend must keep running. Check the backend window for `[camera]` messages that explain the problem. |
| Agent: "camera not found on the network" | The camera is off or unplugged, or the agent computer is on a different network. Run `python site_agent.py discover` to check. |
| Agent: "cannot read video" | The camera was found, but the camera username, password or path in `agent.json` is wrong. |
| Agent: "could not send to the server" | Check the `server` address in `agent.json`, that the backend is running, and the TrashWatch login. |
