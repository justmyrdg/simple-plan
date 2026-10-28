# Deploying TrashWatch to AWS EC2

Two scripts do the work:

| Script | Runs on | What it does |
|---|---|---|
| `deploy/deploy.ps1` | Your Windows laptop | Builds the website, packages the app, uploads it, runs the setup |
| `deploy/setup_ec2.sh` | The EC2 server (run for you) | Installs Python and nginx, sets up the backend as a service, serves the website |

Run `deploy.ps1` again any time to update the server. The server's database, settings (`.env`)
and login secret are never overwritten.

## 1. Create the EC2 instance (once)

In the AWS console, go to **EC2 → Launch instance**:

| Setting | Value |
|---|---|
| AMI | **Ubuntu Server 24.04 LTS** |
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

From the project folder in PowerShell:

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
