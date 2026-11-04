# TrashWatch: Summary

This document has two parts:

1. [Plain-words overview](#part-1-plain-words-overview): for anyone, no technical background needed.
2. [Technical summary](#part-2-technical-summary): for developers and the thesis panel.

---

# Part 1: Plain-words overview

## The problem
Trash collection areas fill up, and the garbage truck doesn't always come on time. Residents often don't know when the truck is coming. Officials can't easily tell whether an area was actually cleared.

## What TrashWatch does
TrashWatch is a system that watches collection areas with cameras, tells residents when the truck is coming, and checks whether the trash was actually collected.

## How it works, step by step

**1. A camera watches the area.**
A camera is placed at each collection area. About every 30 seconds, the system takes a picture from it.

**2. The computer decides: full or not full.**
The system looks at each picture and decides whether the area is full of trash. It learned how by studying many example photos of clean areas and trash-filled areas, a bit like teaching a person to spot the difference. It also gives a confidence score, and it can show which part of the picture looks like trash.

**3. Residents get a text before the truck arrives.**
An administrator enters each area's pickup schedule, for example every Monday at 7 AM. The system sends a text message to the residents who signed up, shortly before pickup and again at pickup time. Messages can be in English or Filipino.

**4. Anyone can check the schedule online.**
There is a public web page. Residents choose their area and see when the truck comes. No login is needed.

**5. The system checks if the trash was really collected.**
Around each pickup time, it looks at the camera's history and decides:

- **Collected:** the area was full, then became clean and stayed clean.
- **Missed:** the area was still full after the pickup time. The administrators get a text alert.
- **No waste:** the area was never full.
- **No data:** the camera wasn't reporting.

Photos from before and after serve as proof.

## What the administrator can do
Administrators log in to a private dashboard to:

- See all collection areas on a map, with a live status for each (full or clear, camera online or offline).
- Add or edit areas, residents' phone numbers and pickup schedules.
- Watch a live camera feed.
- Save photos and record video clips from the cameras.
- View reports on how often collections were on time or missed, and download them as a spreadsheet.
- See a log of every text message sent.

## Privacy and safety

- A resident's number is saved only with their consent.
- Every text can include a way to stop receiving messages. Opting out takes effect immediately.
- If a resident is removed, their name and number are hidden in the message history.
- Old photos and videos are deleted automatically after a set number of days.
- The system follows the Philippine Data Privacy Act (RA 10173).

## What it needs to run

- A camera at each area, such as the Hikvision IP cameras already in use.
- A server, which can be a computer or a cloud server (Amazon).
- A way to send texts. There is a free option that uses an Android phone as the sender, or a paid service.

---

# Part 2: Technical summary

## Main parts

| Part | Tech | Role |
|---|---|---|
| `trash_detector.py` | Python, CLIP (`transformers`) | The trash/clean model, plus a CLI for training, evaluating, capturing and testing images |
| `backend/` | FastAPI, SQLite (SQLAlchemy 2) | Detection, JWT login, CRUD, SMS reminders, collection tracking, media |
| `frontend/` | Angular 21 (standalone, signals, zoneless), Leaflet | Public pickup checker and the admin dashboard |
| `agent/site_agent.py` | Python (`opencv-python`, `requests`) | Runs on the cameras' network and posts a frame per camera to `/api/detect` every 30 s, for when the server (e.g. EC2) can't reach the cameras. Finds Hikvision cameras through SADP |
| `deploy/` | PowerShell, bash | EC2 deployment: systemd service, nginx, optional certbot |
| `docs/` | Markdown | SMS setup, accuracy testing, privacy (RA 10173), remote camera access |
| `index.py` | OpenCV | Small RTSP viewer for a Hikvision camera. The app doesn't use it |

## The detection model

- **Trained head (default):** a logistic-regression layer on normalized CLIP embeddings, loaded from `trash_head.pt`. The sigmoid output is the trash probability.
- **Zero-shot fallback:** cosine similarity against trash and clean text prompts.
- `analyze()` scores the full frame plus a `grid × grid` set of crops, and returns the score, a verdict, per-cell scores and the share of trash cells.
- Training data is in `Images/clean/` and `Images/trash/`.

## Backend behavior

- **Detection (`/api/detect`):**
  - Requires login.
  - Updates the area's status, score and last-checked time.
  - Logs a `Detection` row only when the status changes or 60 s have passed.
  - On a status change it also saves the frame as proof.
  - "Camera online" means checked within the last 2 minutes.
- **Cameras (`cameras.py`):**
  - IP/RTSP cameras are set per area.
  - One reader thread per area keeps only the newest frame.
  - Serves a snapshot endpoint and an MJPEG stream.
  - A background loop checks every camera area every 30 s, with no browser open.
- **Pickup schedules (`pickups.py`):** weekly (by weekday) or one-off (by date), in naive local time.
- **SMS reminders (`scheduler.py`):**
  - Runs every 60 s.
  - Sends a reminder `notify_minutes_before` the pickup.
  - Can also send an at-pickup SMS.
  - Duplicates are prevented with `SmsLog`, and it catches up after downtime.
- **Collection tracking (`collection_tracker.py`):** judges detection history in the window [scheduled − 2 h, scheduled + 4 h]:
  - `collected`: full, then clean for at least 3 minutes.
  - `missed`: still full at the end of the window. Sends one SMS to the admins.
  - `no_waste`: never full.
  - `no_data`: the camera was silent.
  - `pending`: not yet decided.
  - There is deliberately no truck detection.
- **SMS providers (`sms.py`):**
  - SMS Gateway for Android (free), Semaphore, or simulated.
  - Messages are in English or Filipino per contact.
  - They carry an opt-out link when `PUBLIC_URL` is set.
- **Media (`media.py`, `recorder.py`, `storage.py`):**
  - Admins can save snapshots and record video with ffmpeg (copy mode, no audio, fragmented MP4).
  - Recordings have a maximum length.
  - Files go to `backend/captures/` or, if `S3_BUCKET` is set, are uploaded to S3 and deleted locally.
  - Old files are removed after the retention period.
- **Auth:** bcrypt passwords and HS256 JWT. First start creates `admin` / `admin123` (or `ADMIN_PASSWORD`).
- **Database upgrades:** there is no migration tool. New columns go in the `ADDED_COLUMNS` map and are added with `ALTER TABLE` at startup.

## Frontend

- **Public routes:** `/` (pickup checker, `?area=ID`), `/stop` (SMS opt-out), `/privacy` and `/login`.
- **Admin routes** (behind `authGuard`): dashboard, monitor, areas, area detail, reports and SMS log.
- **Monitor page:**
  - Shows the network camera's MJPEG stream and polls the detector.
  - Without a network camera it uses the browser's camera.
  - The verdict and shading are recomputed in the browser from the threshold slider.
- **Media panel:** record, save photo, list, play, download and delete. Used on the Monitor page and in the area's "Photos & videos" tab.
- **Map:** Leaflet with OpenStreetMap tiles and custom pins.
- **Styling:** global CSS only, with light and dark themes.

## Data privacy (RA 10173)

- Creating a contact requires consent, and the time is stored.
- Residents can opt out publicly, and the reply is the same whether or not the number is registered.
- Re-activating an opted-out contact needs fresh consent.
- Deleting a contact masks its details in the SMS log.
- Only Philippine mobile numbers are accepted, stored as `09XXXXXXXXX`.
- The `.gitignore` excludes the database, secrets and agent config.

## Running it

```bash
pip install -r requirements.txt
python -m uvicorn backend.main:app --port 8000   # backend, must be port 8000
cd frontend && npx ng serve                       # http://localhost:4200, proxies /api
python trash_detector.py train Images             # retrain the model
python trash_detector.py evaluate TestImages --save results
```

## Current status

- The system is built and working, on branch `main`.
- The media, recording and S3 storage feature, and `docs/REMOTE_CAMERA.md`, are not committed yet.
- There are no automated tests. The system is checked by running a second backend with a throwaway `TRASHWATCH_DB` and `TRASHWATCH_MEDIA`.
