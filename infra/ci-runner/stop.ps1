# Stops the CI runners on this PC; they stay registered, and start.ps1 (or Docker restarting them) brings them back.
# While they're stopped, CI jobs wait in GitHub's queue for up to 24 hours.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
docker compose stop
