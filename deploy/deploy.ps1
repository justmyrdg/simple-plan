<#
.SYNOPSIS
  Builds TrashWatch and deploys it to an Ubuntu EC2 instance. Run it again to update.

.EXAMPLE
  .\deploy\deploy.ps1 -Server 13.250.1.2 -Key C:\keys\trashwatch.pem
  First deploy, website at http://13.250.1.2

.EXAMPLE
  .\deploy\deploy.ps1 -Server 13.250.1.2 -Key C:\keys\trashwatch.pem -Domain trash.example.com -Email you@example.com
  Same, plus HTTPS (the domain's DNS must already point at the server)

.EXAMPLE
  .\deploy\deploy.ps1 -Server 13.250.1.2 -Key C:\keys\trashwatch.pem -IncludeDatabase
  Also copy this laptop's database (areas, contacts, schedules). Only used if the server has none yet.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Server,      # EC2 public IP or DNS name
  [Parameter(Mandatory = $true)] [string] $Key,         # the .pem key pair file from AWS
  [string] $User = "ubuntu",                            # Ubuntu AMIs; use -User ec2-user on Amazon Linux
  [string] $Domain = "",
  [string] $Email = "",
  [switch] $IncludeDatabase,
  [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP "trashwatch.tar.gz"
# Windows' own tar; Git's GNU tar mistakes "C:" in paths for a remote host
$tar = Join-Path $env:WINDIR "System32\tar.exe"
$sshOpts = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new")
$target = "$User@$Server"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" } }

if (-not (Test-Path $Key)) { throw "Key file not found: $Key" }
if (-not (Test-Path $tar)) { throw "Windows tar.exe not found at $tar" }

Push-Location $root
$uploadedDb = Join-Path $root "backend\trashwatch.uploaded.db"
try {
  if (-not $SkipBuild) {
    Step "Building the website"
    Push-Location frontend
    try { & npx.cmd ng build; Check "Website build" } finally { Pop-Location }
  }
  if (-not (Test-Path "frontend\dist\frontend\browser\index.html")) { throw "No website build found. Run without -SkipBuild." }

  $items = @("backend", "trash_detector.py", "trash_head.pt", "requirements.txt", "frontend/dist/frontend/browser")
  if ($IncludeDatabase) {
    if (-not (Test-Path "backend\trashwatch.db")) { throw "backend\trashwatch.db not found" }
    Copy-Item "backend\trashwatch.db" $uploadedDb -Force
  }

  Step "Packaging"
  # never upload the local database (unless -IncludeDatabase), secrets or caches
  & $tar -czf $archive `
    --exclude "backend/trashwatch.db" --exclude "*.db-journal" --exclude "backend/.env" `
    --exclude "backend/.jwt_secret" --exclude "__pycache__" --exclude "backend/captures" `
    @items
  Check "Packaging"
  "{0:N1} MB" -f ((Get-Item $archive).Length / 1MB) | Write-Host

  Step "Uploading to $Server"
  & scp @sshOpts $archive "deploy/setup_ec2.sh" "${target}:/tmp/"
  Check "Upload (check the IP, the key file, and that port 22 is open in the security group)"

  Step "Setting up the server"
  $remote = "sed -i 's/\r$//' /tmp/setup_ec2.sh && sudo bash /tmp/setup_ec2.sh --archive /tmp/trashwatch.tar.gz '$Domain' '$Email'"
  & ssh @sshOpts -t $target $remote
  Check "Server setup"
}
finally {
  if (Test-Path $uploadedDb) { Remove-Item $uploadedDb -Force }
  Pop-Location
}

Write-Host "`nDone." -ForegroundColor Green
