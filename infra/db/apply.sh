#!/usr/bin/env bash
# Sets up or updates one environment's database on the server (W0-05, D-076).
#
#   infra/db/apply.sh <admin@host> staging
#   infra/db/apply.sh <admin@host> prod      (needs the backup secrets first: sudo erp-db secrets)
#
# Copies infra/db to the server and runs server-apply.sh there. Re-running is safe; the data volume is kept.
set -euo pipefail

[[ $# -eq 2 && ($2 == prod || $2 == staging) ]] || {
  echo "usage: $0 <admin@host> prod|staging" >&2
  exit 2
}
key=${ERP_SSH_KEY:-$HOME/.ssh/zorbix_erp_admin}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

tar -C "$here" --exclude=apply.sh -czf - . |
  ssh -i "$key" -o IdentitiesOnly=yes "$1" \
    "set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; tar -C \"\$d\" -xzf -; sudo bash \"\$d/server-apply.sh\" $2 \"\$d\""
