#!/usr/bin/env bash
# Sets up (or updates) TrashWatch on an EC2 instance running Amazon Linux 2023 or Ubuntu 24.04.
#
# From a git clone on the server (builds the website on the server):
#     sudo dnf install -y git                 # Amazon Linux (Ubuntu: sudo apt install -y git)
#     git clone https://github.com/<you>/<repo>.git && cd <repo>
#     sudo bash deploy/setup_ec2.sh                                   # http://<server IP>
#     sudo bash deploy/setup_ec2.sh trash.example.com you@example.com # adds HTTPS
#   To update later:  git pull && sudo bash deploy/setup_ec2.sh
#
# From deploy.ps1 on Windows (uploads an archive with the website already built):
#     sudo bash setup_ec2.sh --archive /tmp/trashwatch.tar.gz [domain] [email]
#
# What it does:
#   - installs Python 3.11+, nginx (and certbot when a domain is given), adds swap on small instances
#   - copies the app into /opt/trashwatch, keeping the server's database, .env and secrets
#   - installs the Python packages in a virtualenv (CPU-only PyTorch, much smaller than the default)
#   - runs the backend as the systemd service "trashwatch" (starts on boot, restarts if it crashes)
#   - serves the website with nginx and forwards /api to the backend
set -euo pipefail

ARCHIVE=""
if [[ "${1:-}" == "--archive" ]]; then ARCHIVE="${2:?--archive needs a file}"; shift 2; fi
DOMAIN="${1:-}"
EMAIL="${2:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the git clone this script is in
APP_DIR=/opt/trashwatch
APP_USER=trashwatch
NODE_MAJOR=22

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
step() { echo; echo "==> $*"; }
# sudo on Amazon Linux leaves /usr/local/bin (where Node goes) out of PATH
export PATH="/usr/local/bin:$PATH"
export NG_CLI_ANALYTICS=false

# remember the domain, so an update run without it keeps HTTPS
DOMAIN_FILE=/etc/trashwatch-domain
if [[ -n "$DOMAIN" ]]; then echo "$DOMAIN" > "$DOMAIN_FILE"; elif [[ -f "$DOMAIN_FILE" ]]; then DOMAIN=$(cat "$DOMAIN_FILE"); fi

if command -v dnf >/dev/null; then OS=amzn; elif command -v apt-get >/dev/null; then OS=ubuntu
else echo "Unsupported Linux: needs Amazon Linux 2023 or Ubuntu." >&2; exit 1; fi

# ---------- system packages ----------
step "Installing system packages"
if [[ $OS == amzn ]]; then
  # the default python3 on Amazon Linux 2023 is 3.9; the app needs 3.10+
  # curl is already there as curl-minimal; asking for the full curl package conflicts with it
  dnf install -y -q nginx tar gzip xz
  PY=""
  for v in 3.12 3.11; do
    if dnf install -y -q "python$v" "python$v-pip" 2>/dev/null; then PY="python$v"; break; fi
  done
  [[ -n "$PY" ]] || { echo "Could not install Python 3.11 or 3.12" >&2; exit 1; }
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q python3 python3-venv python3-pip nginx curl xz-utils
  PY=python3
  if [[ -n "$DOMAIN" ]]; then apt-get install -y -q certbot python3-certbot-nginx; fi
fi

# pickup times are local times; EC2 runs on UTC by default, which would send reminders 8 hours late
TIMEZONE="${TIMEZONE:-Asia/Manila}"
step "Setting the time zone to $TIMEZONE"
timedatectl set-timezone "$TIMEZONE"

free_mb() { df -Pm / | awk 'NR==2 {print $4}'; }
disk_help() {
  echo "Not enough disk space: $(free_mb) MB free, about $1 MB needed." >&2
  echo "Make the disk bigger (20 GB recommended): EC2 console -> Volumes -> select the instance's volume" >&2
  echo "-> Actions -> Modify volume -> Size 20 -> Modify. Then on the server run:" >&2
  echo "    sudo growpart \$(findmnt -no SOURCE / | sed -E 's/p?[0-9]+\$//') 1 && sudo xfs_growfs -d /     # Amazon Linux" >&2
  echo "    sudo growpart /dev/nvme0n1 1 && sudo resize2fs \$(findmnt -no SOURCE /)                       # Ubuntu" >&2
  echo "and run this script again." >&2
  exit 1
}

# the AI model needs about 2 GB of memory; give small instances 2 GB of swap
# (not more: the default EC2 disk is only 8 GB)
SWAP_MB=2048
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap_active() { swapon --show=NAME --noheadings | grep -qx /swapfile; }
if (( mem_mb < 3800 )); then
  # a swap file left half-made by an interrupted run can't be turned on: start over
  if [[ -f /swapfile ]] && ! swap_active && ! swapon /swapfile 2>/dev/null; then
    rm -f /swapfile
  fi
  swap_mb=$(( $(stat -c %s /swapfile 2>/dev/null || echo 0) / 1048576 ))
  if (( swap_mb > SWAP_MB )); then
    step "Shrinking swap to 2 GB to free disk space"
    swapoff /swapfile 2>/dev/null || true
    rm -f /swapfile
    swap_mb=0
  fi
  if (( swap_mb == 0 )); then
    if (( $(free_mb) < SWAP_MB + 4500 )); then
      echo "WARNING: skipping swap, the disk is too small. With ${mem_mb} MB memory the backend may run out of memory."
    else
      step "Adding 2 GB swap (instance has ${mem_mb} MB memory)"
      dd if=/dev/zero of=/swapfile bs=1M count=$SWAP_MB status=none
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null   # no -q: Amazon Linux's mkswap doesn't have it
      swapon /swapfile
    fi
  fi
  if [[ -f /swapfile ]]; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    sed -i '\|^/swapfile |d' /etc/fstab   # don't leave a boot entry for a file that's gone
  fi
fi

# Amazon Linux keeps /tmp in memory (small); download and unpack big packages on disk instead
export TMPDIR=/var/tmp/trashwatch-build
mkdir -p "$TMPDIR"

# ---------- app files ----------
step "Copying the app into $APP_DIR"
id "$APP_USER" &>/dev/null || useradd --system --home-dir "$APP_DIR" --shell "$(command -v nologin)" "$APP_USER"
mkdir -p "$APP_DIR"
chmod 755 "$APP_DIR"
if [[ -n "$ARCHIVE" ]]; then
  # the archive never contains trashwatch.db, .env or .jwt_secret, so the server's copies survive updates
  tar -xzf "$ARCHIVE" -C "$APP_DIR"
else
  [[ -f "$SRC_DIR/backend/main.py" ]] || { echo "Run this from inside the cloned repository." >&2; exit 1; }
  # same files the git repo has; local databases/secrets in the clone are never copied
  tar -C "$SRC_DIR" -cf - --exclude=.git --exclude=Images --exclude=node_modules --exclude=dist --exclude=.angular \
      --exclude=__pycache__ --exclude='backend/*.db' --exclude=backend/.env --exclude=backend/.jwt_secret \
      backend frontend trash_detector.py trash_head.pt requirements.txt \
    | tar -C "$APP_DIR" -xf -
  # a database copied into the clone by hand (see deploy/README.md)
  if [[ -f "$SRC_DIR/backend/trashwatch.uploaded.db" ]]; then
    cp "$SRC_DIR/backend/trashwatch.uploaded.db" "$APP_DIR/backend/trashwatch.uploaded.db"
  fi
fi
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
  admin_pw=$($PY -c 'import secrets; print(secrets.token_urlsafe(9))')
  cp "$APP_DIR/backend/.env.example" "$APP_DIR/backend/.env"
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$admin_pw/" "$APP_DIR/backend/.env"
  # cameras on a private network can't be reached from EC2; use the site agent instead
  sed -i "s/^CAMERA_CHECK_SECONDS=.*/CAMERA_CHECK_SECONDS=0/" "$APP_DIR/backend/.env"
  if [[ ! -f "$APP_DIR/backend/trashwatch.db" ]]; then
    echo "NEW_ADMIN_PASSWORD=$admin_pw" > /root/trashwatch-admin-password.txt
  fi
fi

# ---------- website ----------
if [[ -z "$ARCHIVE" ]]; then
  step "Building the website (first time takes a few minutes)"
  if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
    # official Node.js build; distro packages are often too old for Angular
    arch=$(uname -m); [[ $arch == aarch64 ]] && arch=arm64; [[ $arch == x86_64 ]] && arch=x64
    base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
    file=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}')
    curl -fsSL "$base/$file" | tar -xJ -C /usr/local --strip-components=1
  fi
  echo "Node $(node -v)"
  # npm install, not npm ci: the lock file comes from Windows and lacks some Linux-only
  # optional packages, which npm ci refuses; this only touches the copy in $APP_DIR
  (cd "$APP_DIR/frontend" && npm install --no-audit --no-fund --no-update-notifier --loglevel=error && npx ng build)
  # only the built files are needed; free ~500 MB
  rm -rf "$APP_DIR/frontend/node_modules" "$APP_DIR/frontend/.angular"
  npm cache clean --force --loglevel=error
fi
[[ -f "$APP_DIR/frontend/dist/frontend/browser/index.html" ]] || { echo "Website build missing." >&2; exit 1; }

# ---------- python ----------
step "Installing Python packages (first time takes a few minutes)"
# packages (~1.5 GB) plus the AI model download (~0.6 GB), with some room to spare
[[ -x "$APP_DIR/venv/bin/uvicorn" ]] || (( $(free_mb) >= 3000 )) || disk_help 3000
[[ -d "$APP_DIR/venv" ]] || $PY -m venv "$APP_DIR/venv"
pip=("$APP_DIR/venv/bin/pip" install -q --no-cache-dir)
"${pip[@]}" --upgrade pip
"${pip[@]}" torch --index-url https://download.pytorch.org/whl/cpu
# the server has no screen, so use the headless OpenCV build
sed 's/^opencv-python$/opencv-python-headless/' "$APP_DIR/requirements.txt" > "$TMPDIR/requirements.txt"
"${pip[@]}" -r "$TMPDIR/requirements.txt"
rm -rf "$TMPDIR"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/backend/.env"

# ---------- backend service ----------
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
Environment=TZ=$TIMEZONE
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

# ---------- nginx ----------
step "Setting up nginx"
site=$(cat <<EOF
server {
    listen 80 default_server;
    server_name ${DOMAIN:-_};

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
)
if [[ $OS == amzn ]]; then
  # Amazon Linux's nginx.conf has its own default server on port 80; replace it with a plain one
  [[ -f /etc/nginx/nginx.conf.orig ]] || cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.orig
  cat > /etc/nginx/nginx.conf <<'EOF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
include /usr/share/nginx/modules/*.conf;
events { worker_connections 1024; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log /var/log/nginx/access.log;
    sendfile on;
    keepalive_timeout 65;
    include /etc/nginx/conf.d/*.conf;
}
EOF
  echo "$site" > /etc/nginx/conf.d/trashwatch.conf
  # with SELinux enforcing, nginx may not connect to the backend or read /opt by default
  if command -v getenforce >/dev/null && [[ $(getenforce) == Enforcing ]]; then
    setsebool -P httpd_can_network_connect 1
    chcon -R -t httpd_sys_content_t "$APP_DIR/frontend/dist"
  fi
else
  echo "$site" > /etc/nginx/sites-available/trashwatch
  ln -sf /etc/nginx/sites-available/trashwatch /etc/nginx/sites-enabled/trashwatch
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t -q
systemctl enable -q nginx
systemctl restart nginx

# ---------- HTTPS ----------
if [[ -n "$DOMAIN" ]]; then
  step "Getting an HTTPS certificate for $DOMAIN"
  if [[ $OS == amzn ]] && ! command -v certbot >/dev/null; then
    # Amazon Linux has no certbot package; use certbot's own pip install
    $PY -m venv /opt/certbot
    /opt/certbot/bin/pip install -q certbot certbot-nginx
    ln -sf /opt/certbot/bin/certbot /usr/local/bin/certbot
    # renew twice a day; certbot only renews certificates close to expiry
    dnf install -y -q cronie
    systemctl enable -q --now crond
    echo "0 3,15 * * * root /usr/local/bin/certbot renew -q --deploy-hook 'systemctl reload nginx'" > /etc/cron.d/certbot
  fi
  if [[ -n "$EMAIL" ]]; then contact=(-m "$EMAIL"); else contact=(--register-unsafely-without-email); fi
  # reuses the existing certificate on later runs; the domain must already point at this server
  certbot --nginx -n --agree-tos --redirect -d "$DOMAIN" "${contact[@]}"
fi

# ---------- check ----------
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

token=$(curl -fs -m 2 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)
public_ip=$(curl -fs -m 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
echo
echo "TrashWatch is running."
if [[ -n "$DOMAIN" ]]; then echo "  Website: https://$DOMAIN"; else echo "  Website: http://${public_ip:-<server public IP>}"; fi
if [[ -f /root/trashwatch-admin-password.txt ]]; then
  echo "  First login: admin / $(cut -d= -f2 /root/trashwatch-admin-password.txt)   (change it after logging in)"
  rm -f /root/trashwatch-admin-password.txt
fi
echo "  Logs:     sudo journalctl -u trashwatch -f"
echo "  Settings: sudo nano $APP_DIR/backend/.env   then   sudo systemctl restart trashwatch"
