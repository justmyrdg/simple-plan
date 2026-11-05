<#
.SYNOPSIS
  Sets KEY=VALUE lines in the EC2 server's backend/.env and restarts the backend. Run from your PC.

.EXAMPLE
  .\deploy\set_env_ec2.ps1 -Server 3.105.44.178 -Key C:\keys\trashwatch.pem -User ec2-user SMS_PROVIDER=smsgate S3_BUCKET=my-bucket AWS_REGION=ap-southeast-2
  Other lines in the file are left alone. Existing keys are replaced, new ones added.

.EXAMPLE
  .\deploy\set_env_ec2.ps1 -Server 3.105.44.178 -Key C:\keys\trashwatch.pem -User ec2-user "PUBLIC_URL=https://3-105-44-178.sslip.io" -NoRestart
  Quote a setting that contains spaces or special characters. -NoRestart skips the restart.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Server,      # EC2 public IP or DNS name
  [Parameter(Mandatory = $true)] [string] $Key,         # the .pem key pair file from AWS
  [string] $User = "ubuntu",                            # Ubuntu AMIs; use -User ec2-user on Amazon Linux
  [string] $EnvFile = "/opt/trashwatch/backend/.env",
  [switch] $NoRestart,
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)] [string[]] $Settings
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Key)) { throw "Key file not found: $Key" }
foreach ($s in $Settings) {
  if ($s -notmatch '^[A-Za-z_][A-Za-z0-9_]*=') { throw "Expected KEY=VALUE, got: $s" }
}

# single-quote each setting for the server's shell ( ' becomes '\'' )
$quoted = ($Settings | ForEach-Object { "'" + $_.Replace("'", "'\''") + "'" }) -join " "
$remote = "sudo python3 - --file '$EnvFile' $quoted"
if (-not $NoRestart) { $remote += " && sudo systemctl restart trashwatch && echo 'Backend restarted.'" }

# set_env.py is sent over the connection, so it doesn't need to exist on the server
$script = Join-Path $PSScriptRoot "set_env.py"
Get-Content -Raw $script | & ssh -i $Key -o StrictHostKeyChecking=accept-new "$User@$Server" $remote
if ($LASTEXITCODE -ne 0) { throw "Updating the server's .env failed (exit code $LASTEXITCODE)" }
