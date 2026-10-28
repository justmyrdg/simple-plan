# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TrashWatch: cameras placed at collection areas detect whether an area is full of trash. Admins manage areas on a map, each area's residents' phone numbers and its garbage-truck pickup schedule; residents get an SMS before each pickup and can check the schedule on a public page without logging in.

- `trash_detector.py` — the model and a standalone CLI (Python, CLIP via `transformers`)
- `backend/` — FastAPI + SQLite (SQLAlchemy 2) server: detection, JWT login, CRUD, SMS reminders
- `agent/site_agent.py` — runs on the cameras' network and posts a frame per camera to `/api/detect` every 30 s, for when the server can't reach the cameras (e.g. EC2). Finds Hikvision cameras by MAC/serial via SADP (UDP multicast 239.255.255.250:37020) and remembers the last IP in `.agent_state.json`. Only needs `opencv-python` + `requests`. `python agent/site_agent.py discover` / `run [--once] [--config]`; config in `agent/agent.json` (see `agent.example.json`). Setup guide: `CAMERA_SETUP.md`.
- `deploy/` — EC2 deployment: `deploy.ps1` (Windows: builds the frontend, tars the app without the DB/.env/.jwt_secret, scp + runs) and `setup_ec2.sh` (Ubuntu 24.04: CPU-only torch venv in /opt/trashwatch, systemd service `trashwatch` with one uvicorn worker, nginx serving `frontend/dist/frontend/browser` and proxying /api with buffering off for MJPEG, optional certbot). See `deploy/README.md`.
- `frontend/` — Angular 21 app (standalone components, signals, zoneless, lazy routes, Leaflet map)

Git repository (branch `main`). Never commit secrets or private data: `.gitignore` excludes `backend/.env`, `backend/.jwt_secret`, `backend/*.db` (residents' phone numbers) and `agent/agent.json`; `index.py` reads the camera password from `CAMERA_PASSWORD`. Windows machine; Python 3.12, Node 22.

## Commands

```bash
pip install -r requirements.txt

# CLI
python trash_detector.py train Images                 # retrain trash_head.pt from labeled images
python trash_detector.py image path/to/photo.jpg      # also: folder <dir>, webcam [--camera N]
#   flags: --threshold 0.5  --grid 3 (0 = off)  --save <dir>  --no-show  --zero-shot  --head <file>

# Backend (must be port 8000 — the Angular proxy targets it)
python -m uvicorn backend.main:app --port 8000        # from project root
python main.py                                         # from inside backend/
TRASHWATCH_DB=/tmp/test.db python -m uvicorn backend.main:app --port 8001   # throwaway DB for testing

# Frontend (from frontend/)
npx ng serve      # http://localhost:4200, proxies /api -> localhost:8000 via proxy.conf.json
npx ng serve --port 4300 --proxy-config <file>   # second instance against a test backend
npx ng build
```

First start creates `backend/trashwatch.db`, an `admin` / `admin123` login (or `ADMIN_PASSWORD`), and a "Test Area" with one camera. Settings go in `backend/.env` (see `.env.example`); `main.py` loads it itself, no python-dotenv.

There are no automated tests and no linter beyond Prettier settings in `frontend/.prettierrc`. `fastapi.testclient` can't be used (httpx is not installed), so test the API by running a second backend with `TRASHWATCH_DB` and calling it over HTTP.

## Architecture

**Model (`trash_detector.py`).** `TrashDetector` loads `openai/clip-vit-base-patch32` and scores images in one of two ways:
- *Trained head* (default when `trash_head.pt` exists): a single `nn.Linear` logistic-regression layer on normalized CLIP image embeddings, sigmoid output = trash probability.
- *Zero-shot* fallback: cosine similarity against `TRASH_PROMPTS` / `CLEAN_PROMPTS`, softmax, summed trash-prompt probability.

`analyze(bgr, grid)` scores the full frame plus a `grid × grid` set of crops in one batch, returning `score`, `is_trash`, `cells` (2-D array), and `trash_cell_ratio`. `annotate()` draws the OpenCV overlay.

Gotchas:
- `_as_tensor()` exists because transformers ≥ 5 returns an output object from `get_image_features` / `get_text_features`; keep using it.
- `fit_head` trains on embeddings ×10 and then folds the ×10 into the weights, so inference uses raw normalized embeddings. Preserve that if changing training.
- `train` reads labels from parent folder names (`clean/`, `trash/`, `dirty/`, …) or filename prefixes (`clean_*`, `dirty_*`). Training data is in `Images/clean/` and `Images/trash/`. The backend loads `trash_head.pt` only at startup.

**Backend (`backend/`).**
- `main.py` puts the project root on `sys.path` and imports sibling modules as `backend.*` (absolute), so both `python main.py` and `uvicorn backend.main:app` work. The other modules use relative imports. On startup it creates tables and seeds data (`init_db`), then starts the reminder loop as an asyncio task. It also defines `/api/health` and `/api/detect`.
- `/api/detect` requires login. With `area_id` it updates that area's `last_status` / `last_score` / `last_checked_at` and writes a `Detection` row only when the status changes or 60 s have passed (`DETECTION_LOG_EVERY`). The dashboard's "camera online" means checked within the last 2 minutes.
- Routers: `auth.py` (bcrypt + HS256 JWT; secret from `JWT_SECRET` or auto-generated in `backend/.jwt_secret`), `areas.py` (admin CRUD for areas, contacts, schedules, plus test/notify SMS), `dashboard.py` (summary + SMS log), `public.py` (no auth). Admin routers apply `Depends(current_user)` at the router level.
- `cameras.py`: network (IP/RTSP) cameras, set per area in `Area.camera_url`. One reader thread per area keeps only the newest frame (RTSP forced to TCP) and stops after 60 s unused. Endpoints: `/api/cameras/{id}/snapshot`, `/stream` (MJPEG for an `<img>`, so it also accepts `?token=`), and `/detect` (defined in `main.py`, records the area's status). `main.py`'s `camera_watch_loop` also checks every camera-URL area every `CAMERA_CHECK_SECONDS` (default 30, 0 = off) with no browser open. All detector calls go through `run_detector`, which holds a lock because the detector stores its threshold as state.
- `init_db` adds `areas.camera_url` to older databases with `ALTER TABLE`; do the same for any future column rather than asking users to delete the DB.
- `pickups.py` expands `Schedule` rows into datetimes. `kind='weekly'` uses `weekday` (0 = Monday); `kind='once'` uses `date`. All times are naive local time.
- `scheduler.py` runs `send_due_reminders` every 60 s. For each pickup in `[now, now + notify_minutes_before]` it texts each active contact once. Duplicates are prevented by looking up `SmsLog` by (schedule_id, occurrence date, phone), so it also catches up after downtime. It accepts a `now` argument, so you can test it directly against a test DB.
- `sms.py`: Semaphore (`SEMAPHORE_API_KEY`); without a key, messages are "simulated" (printed and logged). `normalize_phone` only accepts PH mobile numbers and stores them as `09XXXXXXXXX`. Contacts are unique per (area, phone).
- SQLite foreign keys are turned on by a connect listener in `db.py`. There are no migrations: `create_all` won't alter existing tables, so delete `trashwatch.db` (or migrate by hand) after changing a model.

**Frontend (`frontend/src/app/`).**
- Routes (`app.routes.ts`): `/` is the public pickup checker (`?area=ID` preselects an area), `/login`, and `/admin/*` (behind `authGuard`, inside `AdminLayout`): dashboard, monitor, areas, areas/:id, sms. `withComponentInputBinding` passes route and query params to component `input()`s.
- `core/auth.service.ts` holds the token in localStorage, the functional `authInterceptor` (adds the bearer token except on `/api/public`, and logs out and redirects on 401) and `authGuard`. `core/api.service.ts` has the typed API calls and `errorMessage()`, which flattens FastAPI `detail` messages, including 422 validation lists.
- `pages/monitor.ts` / `monitor.html` is the camera page. If the selected area has a `camera_url`, the feed defaults to "Network camera": the page shows the MJPEG stream and polls `/api/cameras/{id}/detect`; otherwise it uses the browser's camera. The browser-camera loop sends the next frame only after the previous response arrives, then waits `intervalMs`. Live frames send the selected `area_id` (remembered in localStorage); uploads don't, so test photos don't change an area's status. The verdict and region shading are recomputed client-side from `score` / `cells` against the threshold slider.
- `shared/area-map.ts` wraps Leaflet with OpenStreetMap tiles. Pins are `divIcon`s styled by `.pin-*` classes (this avoids Leaflet's broken default marker image paths under bundlers). Pick mode emits clicks and pin drags for the area form. `leaflet` is listed in `allowedCommonJsDependencies`.
- The icon sprite (`<symbol id="i-*">`) lives in `src/index.html`; use `<svg class="icon"><use href="#i-name" /></svg>`.
- Styling is global only: `src/styles.css` holds the tokens (light + `prefers-color-scheme: dark`) plus the monitor styles, and `src/pages.css` holds the shell, pages, tables, modals and map. Component stylesheets aren't used, which keeps them under Angular's per-component style budget.
