# Deploying TrashWatch to AWS EC2

Two scripts do the work:

| Script | Runs on | What it does |
|---|---|---|
| `deploy/deploy.ps1` | Your Windows laptop | Builds the website, packages the app, uploads it, runs the setup |
| `deploy/setup_ec2.sh` | The EC2 server (run for you) | Installs Python and nginx, sets up the backend as a service, serves the website |

Run `deploy.ps1` again any time to update the server. The server's database, settings (`.env`)
and login secret are never overwritten.

Updates only redo what changed (each step prints "unchanged, skipping"):

| Step | Skipped when |
|---|---|
| Website build (on your laptop with `deploy.ps1`, on the server with a git clone) | the frontend files are the same as in the last build |
| Installing Python packages | `requirements.txt` is the same |
| Restarting the backend | the backend code, `trash_detector.py`, `trash_head.pt`, `requirements.txt` and the service file are the same (the database, `.env` and captures don't count) |

So a frontend-only change doesn't restart the backend, and a backend-only change doesn't rebuild the website.
To redo everything anyway, use `deploy.ps1 -Force`, or on the server `sudo FORCE=1 bash deploy/setup_ec2.sh`.
(The fingerprints are kept on the server in `/opt/trashwatch/.deployed/`.)

## 1. Create the EC2 instance (once)

In the AWS console, go to **EC2 → Launch instance**:

| Setting | Value |
|---|---|
| AMI | **Amazon Linux 2023** or **Ubuntu Server 24.04 LTS** (both work) |
| Instance type | **t3.medium** (4 GB memory) recommended. A `t3.small` works; the script adds swap, but it's slower. |
| Key pair | Create one and download the `.pem` file, e.g. `C:\keys\trashwatch.pem` |
| Storage | **20 GB** |
| Security group | Allow **SSH (22)** from *My IP*, and **HTTP (80)** and **HTTPS (443)** from *Anywhere* |

Then give it a fixed public address: **EC2 → Elastic IPs → Allocate**, then
**Associate** it with the instance. Without this, the IP changes when the instance is stopped and started.

If Windows complains that the key's permissions are "too open", run this once in PowerShell:

```powershell
icacls C:\keys\trashwatch.pem /inheritance:r /grant:r "$($env:USERNAME):R"
```

## 2. Deploy

There are two ways. Use one.

### Option A: clone from GitHub on the server

Connect to the server (EC2 console → **Connect**, or `ssh -i C:\keys\trashwatch.pem ec2-user@<elastic IP>`), then:

```bash
sudo dnf install -y git            # Ubuntu: sudo apt install -y git
git clone https://github.com/<you>/<repo>.git
cd <repo>
sudo bash deploy/setup_ec2.sh
```

For a private repository, `git clone` asks for your GitHub username and a
**personal access token** (GitHub → Settings → Developer settings → Personal access tokens)
instead of your password.

The first run takes about 10–15 minutes: it builds the website, installs PyTorch and downloads the AI model.
At the end it prints the website address and the **admin password**. Save it, then change it after logging in.

To update after pushing new code:

```bash
cd <repo> && git pull && sudo bash deploy/setup_ec2.sh
```

Your database isn't in GitHub. To copy this laptop's areas and contacts to a new server, upload it
**before the first run**:
`scp -i C:\keys\trashwatch.pem backend\trashwatch.db ec2-user@<elastic IP>:~/<repo>/backend/trashwatch.uploaded.db`,
then run `sudo bash deploy/setup_ec2.sh`. It's only used if the server has no database yet.

### Option B: upload from Windows with deploy.ps1

From the project folder in PowerShell (on Amazon Linux add `-User ec2-user`):

```powershell
.\deploy\deploy.ps1 -Server <elastic IP> -Key C:\keys\trashwatch.pem
```

Add `-IncludeDatabase` on the first deploy to copy this laptop's areas, contacts and schedules.
The first run takes about 10 minutes: it installs PyTorch and downloads the AI model.

At the end it prints the website address and, for a new database, the **admin password**.
Save it, then change it after logging in.

If PowerShell refuses to run the script, allow scripts for this window only:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

## 3. HTTPS with a domain (recommended)

Logins and camera photos travel unencrypted over plain HTTP. If you have a domain:

1. In your domain's DNS, add an **A record**, e.g. `trashwatch.example.com`, pointing to the Elastic IP.
2. Wait until it resolves, then deploy with:

   ```powershell
   .\deploy\deploy.ps1 -Server <elastic IP> -Key C:\keys\trashwatch.pem -Domain trashwatch.example.com -Email you@example.com
   ```

The certificate renews automatically. Later updates remember the domain, so you can leave `-Domain` off.

## 4. Settings on the server

The server's settings are in `/opt/trashwatch/backend/.env` (SMS key, etc.):

```bash
ssh -i C:\keys\trashwatch.pem ubuntu@<elastic IP>
sudo nano /opt/trashwatch/backend/.env
sudo systemctl restart trashwatch
```

`CAMERA_CHECK_SECONDS` is set to `0` on the server, because EC2 can't reach cameras on a private
network. Use the **site agent** instead (see `CAMERA_SETUP.md`, Part 7), with
`"server": "https://trashwatch.example.com"` (or `http://<elastic IP>`) in `agent/agent.json`.
Leave **Network camera address** empty for those areas.

If the server can reach the cameras (see `docs/REMOTE_CAMERA.md`), set `CAMERA_CHECK_SECONDS=30` instead
and put each camera's RTSP address in **Network camera address**.

## 5. Keep photos and videos in S3 (optional)

Without this, status-change photos, saved snapshots and recordings stay on the server's disk
(`/opt/trashwatch/backend/captures`). With it, each file is uploaded to S3 right after it is saved and then
**deleted from the server**; a failed upload is retried every minute. Viewing and downloading go through
short-lived S3 links, so the files never pass through nginx.

1. **Create a private bucket**: S3 → Create bucket, in the same region as the server (e.g. `ap-southeast-1`),
   with **Block all public access** left on.
2. **Create an IAM policy** (IAM → Policies → Create policy → JSON), replacing `YOUR-BUCKET`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
     }]
   }
   ```
3. **Create a role for EC2** (IAM → Roles → Create role → AWS service → EC2) with that policy, then attach it:
   EC2 → the instance → **Actions → Security → Modify IAM role**. No access keys go on the server.
4. **Add to `/opt/trashwatch/backend/.env`**, then `sudo systemctl restart trashwatch`:

   ```
   S3_BUCKET=YOUR-BUCKET
   AWS_REGION=ap-southeast-1
   S3_PREFIX=trashwatch        # optional folder inside the bucket
   ```
5. **Check it**: on the **Monitor** page save a photo, then look in the bucket under `trashwatch/snapshots/`.
   `sudo journalctl -u trashwatch -f` shows `[storage]` lines if an upload or delete fails.

Files are deleted from S3 by the app (retention days in `.env`, the Delete buttons, or deleting an area).
You can also add an S3 lifecycle rule that expires objects after a longer time as a safety net. Existing
photos already on the disk are uploaded by the same retry sweep after the restart.

Recordings use `ffmpeg`, which comes with the Python packages (`imageio-ffmpeg`); nothing else to install.
The camera's upload bandwidth matters: a main stream is roughly 4–8 Mbps, so recording the lighter sub-stream
(`/Streaming/Channels/102`) is kinder to a home connection.

## Useful commands on the server

| Task | Command |
|---|---|
| Live backend logs | `sudo journalctl -u trashwatch -f` |
| Restart the backend | `sudo systemctl restart trashwatch` |
| Backend status | `systemctl status trashwatch` |
| Back up the database | `sudo cp /opt/trashwatch/backend/trashwatch.db ~/trashwatch-$(date +%F).db` |
| nginx errors | `sudo tail -f /var/log/nginx/error.log` |

## Cost

A `t3.medium` costs roughly **US$30–40/month** running all the time, depending on the region,
plus about US$2/month for 20 GB of storage and about US$3.60/month for the public IPv4 address.
Check the AWS pricing page for your region (Singapore, `ap-southeast-1`, is the closest to the Philippines).
