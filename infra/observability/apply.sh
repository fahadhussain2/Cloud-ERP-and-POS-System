#!/usr/bin/env bash
# Sets up or updates observability on the server (W0-06, D-086):
#
#   infra/observability/apply.sh <admin@host>
#
# Copies infra/observability to the server and runs server-apply.sh there. Re-running is safe.
set -euo pipefail

[[ $# -eq 1 ]] || {
  echo "usage: $0 <admin@host>" >&2
  exit 2
}
key=${ERP_SSH_KEY:-$HOME/.ssh/zorbix_erp_admin}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

tar -C "$here" --exclude=apply.sh --exclude=dashboards -czf - . |
  ssh -i "$key" -o IdentitiesOnly=yes "$1" \
    "set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; tar -C \"\$d\" -xzf -; sudo bash \"\$d/server-apply.sh\" \"\$d\""
