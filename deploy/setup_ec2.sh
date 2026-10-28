#!/usr/bin/env bash
# Sets up (or updates) TrashWatch on an Ubuntu 24.04 EC2 instance.
#
# deploy.ps1 uploads the project and runs this for you. To run it by hand on the server:
#     sudo bash setup_ec2.sh /tmp/trashwatch.tar.gz                     # http://<server IP>
#     sudo bash setup_ec2.sh /tmp/trashwatch.tar.gz trash.example.com you@example.com   # adds HTTPS
#
# What it does:
#   - installs Python, nginx (and certbot when a domain is given), adds swap on small instances
#   - unpacks the app into /opt/trashwatch, keeping the server's database, .env and secrets
#   - installs the Python packages in a virtualenv (CPU-only PyTorch, much smaller than the default)
#   - runs the backend as the systemd service "trashwatch" (starts on boot, restarts if it crashes)
#   - serves the website with nginx and forwards /api to the backend
set -euo pipefail

ARCHIVE="${1:?usage: setup_ec2.sh <archive.tar.gz> [domain] [email]}"
DOMAIN="${2:-}"
EMAIL="${3:-}"
APP_DIR=/opt/trashwatch
APP_USER=trashwatch

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
step() { echo; echo "==> $*"; }

# remember the domain, so an update run without it keeps HTTPS
DOMAIN_FILE=/etc/trashwatch-domain
if [[ -n "$DOMAIN" ]]; then echo "$DOMAIN" > "$DOMAIN_FILE"; elif [[ -f "$DOMAIN_FILE" ]]; then DOMAIN=$(cat "$DOMAIN_FILE"); fi

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q python3 python3-venv python3-pip nginx libgl1 libglib2.0-0 curl
if [[ -n "$DOMAIN" ]]; then apt-get install -y -q certbot python3-certbot-nginx; fi

# the AI model needs about 2 GB of memory; give small instances swap so it doesn't get killed
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( mem_mb < 3800 )) && ! swapon --show | grep -q /swapfile; then
  step "Adding 4 GB swap (instance has ${mem_mb} MB memory)"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Unpacking the app into $APP_DIR"
id "$APP_USER" &>/dev/null || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
# the archive never contains trashwatch.db, .env or .jwt_secret, so the server's copies survive updates
tar -xzf "$ARCHIVE" -C "$APP_DIR"
if [[ -f "$APP_DIR/backend/trashwatch.uploaded.db" ]]; then
  if [[ -f "$APP_DIR/backend/trashwatch.db" ]]; then
    echo "Server already has a database; keeping it (the uploaded one is in backend/trashwatch.uploaded.db)."
  else
    mv "$APP_DIR/backend/trashwatch.uploaded.db" "$APP_DIR/backend/trashwatch.db"
    echo "Using the uploaded database."
  fi
fi

if [[ ! -f "$APP_DIR/backend/.env" ]]; then
  # a public server must not use the default admin123 password
  admin_pw=$(python3 -c 'import secrets; print(secrets.token_urlsafe(9))')
  cp "$APP_DIR/backend/.env.example" "$APP_DIR/backend/.env"
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$admin_pw/" "$APP_DIR/backend/.env"
  # cameras on a private network can't be reached from EC2; use the site agent instead
  sed -i "s/^CAMERA_CHECK_SECONDS=.*/CAMERA_CHECK_SECONDS=0/" "$APP_DIR/backend/.env"
  if [[ ! -f "$APP_DIR/backend/trashwatch.db" ]]; then
    echo "NEW_ADMIN_PASSWORD=$admin_pw" > /root/trashwatch-admin-password.txt
  fi
fi

step "Installing Python packages (first time takes a few minutes)"
[[ -d "$APP_DIR/venv" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q torch --index-url https://download.pytorch.org/whl/cpu
# the server has no screen, so use the headless OpenCV build
sed 's/^opencv-python$/opencv-python-headless/' "$APP_DIR/requirements.txt" > /tmp/trashwatch-requirements.txt
"$APP_DIR/venv/bin/pip" install -q -r /tmp/trashwatch-requirements.txt

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/backend/.env"

step "Setting up the backend service"
cat > /etc/systemd/system/trashwatch.service <<EOF
[Unit]
Description=TrashWatch backend
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HF_HOME=$APP_DIR/.hf-cache
# one worker only: the model is loaded once and the SMS reminder loop must not run twice
ExecStart=$APP_DIR/venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q trashwatch
systemctl restart trashwatch

step "Setting up nginx"
server_name="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/trashwatch <<EOF
server {
    listen 80 default_server;
    server_name $server_name;

    root $APP_DIR/frontend/dist/frontend/browser;
    index index.html;
    client_max_body_size 20m;   # photo uploads

    # live camera video (MJPEG) must not be buffered
    location ~ ^/api/cameras/.+/stream {
        proxy_pass http://127.0.0.1:8000;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_read_timeout 120s;    # detection can take a few seconds on a small CPU
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Angular routes such as /admin/areas are handled by index.html
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
ln -sf /etc/nginx/sites-available/trashwatch /etc/nginx/sites-enabled/trashwatch
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
systemctl reload nginx

if [[ -n "$DOMAIN" ]]; then
  step "Getting an HTTPS certificate for $DOMAIN"
  if [[ -n "$EMAIL" ]]; then contact=(-m "$EMAIL"); else contact=(--register-unsafely-without-email); fi
  # reuses the existing certificate on later runs; the domain must already point at this server
  certbot --nginx -n --agree-tos --redirect -d "$DOMAIN" "${contact[@]}"
fi

step "Waiting for the backend (the first start downloads the AI model, ~600 MB)"
for i in $(seq 1 90); do
  if curl -fs http://127.0.0.1:8000/api/health >/dev/null; then
    echo "Backend is up: $(curl -s http://127.0.0.1:8000/api/health)"
    break
  fi
  if (( i == 90 )); then
    echo "Backend did not answer after 7.5 minutes. See: sudo journalctl -u trashwatch -n 50" >&2
    exit 1
  fi
  sleep 5
done

public_ip=$(curl -fs -m 3 http://checkip.amazonaws.com || true)
echo
echo "TrashWatch is running."
if [[ -n "$DOMAIN" ]]; then echo "  Website: https://$DOMAIN"; else echo "  Website: http://${public_ip:-<server IP>}"; fi
if [[ -f /root/trashwatch-admin-password.txt ]]; then
  echo "  First login: admin / $(cut -d= -f2 /root/trashwatch-admin-password.txt)   (change it after logging in)"
  rm -f /root/trashwatch-admin-password.txt
fi
echo "  Logs:    sudo journalctl -u trashwatch -f"
echo "  Settings: sudo nano $APP_DIR/backend/.env   then   sudo systemctl restart trashwatch"
