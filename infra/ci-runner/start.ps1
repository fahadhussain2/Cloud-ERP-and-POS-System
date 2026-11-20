# Starts the CI runners on this PC (D-119). Run it once, and again after remove.ps1 or a new runner image.
# The registration token goes from GitHub (your own gh sign-in) straight into the containers; nobody copies it.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
# The runner image carries pnpm at the version the repository uses ("packageManager": "pnpm@x.y.z").
$env:PNPM_VERSION = ((Get-Content ../../package.json -Raw | ConvertFrom-Json).packageManager -split '@')[1]
$env:RUNNER_TOKEN = gh api -X POST 'repos/fahadhussain2/Cloud-ERP-and-POS-System/actions/runners/registration-token' --jq .token
try {
  docker compose up -d --build --remove-orphans
} finally {
  Remove-Item Env:RUNNER_TOKEN
}
docker compose ps
