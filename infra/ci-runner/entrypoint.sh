#!/usr/bin/env bash
# Registers the runner on its first start (RUNNER_TOKEN from start.ps1), then runs it. A restart (reboot, Docker
# Desktop restart) keeps the container and its registration, so no new token is needed.
set -euo pipefail

: "${RUNNER_NAME:?}" "${REPO_URL:?}"
# The work folder has the same path here and on the Docker host, so a job's `docker run -v "$PWD/…"` finds its files.
work="/srv/ci-runner/$RUNNER_NAME/_work"
sudo mkdir -p "$work"
sudo chown runner:runner "$work"

if [[ ! -f .runner ]]; then
  if [[ -z ${RUNNER_TOKEN:-} ]]; then
    echo "Not registered and no RUNNER_TOKEN: run infra/ci-runner/start.ps1." >&2
    exit 1
  fi
  ./config.sh --unattended --replace --url "$REPO_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels erp-pc --work "$work"
fi
unset RUNNER_TOKEN
exec ./run.sh
