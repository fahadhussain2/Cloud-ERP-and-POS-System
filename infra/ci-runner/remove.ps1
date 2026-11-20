# Removes the CI runners: deletes the containers and unregisters erp-pc-1..3 from GitHub.
# Afterwards CI jobs only run on GitHub's machines if CHECKS_RUNS_ON says so (README.md).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repo = 'fahadhussain2/Cloud-ERP-and-POS-System'
docker compose down --remove-orphans
$ids = gh api "repos/$repo/actions/runners" --jq '.runners[] | select(.name | startswith(\"erp-pc-\")) | .id'
foreach ($id in $ids) { gh api -X DELETE "repos/$repo/actions/runners/$id" }
