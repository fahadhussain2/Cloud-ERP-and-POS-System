#!/usr/bin/env bash
# Copies infra/server to the server and runs bootstrap.sh there (W0-03).
#
#   infra/server/apply.sh <user@host> [--lock-ssh] [--upgrade]
#
# SSH key: $ERP_SSH_KEY, default ~/.ssh/zorbix_erp_admin. The first run is as root; later runs as admin.
set -euo pipefail

[[ $# -ge 1 ]] || {
  echo "usage: $0 <user@host> [bootstrap options]" >&2
  exit 2
}
target=$1
shift
key=${ERP_SSH_KEY:-$HOME/.ssh/zorbix_erp_admin}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
args=$(printf ' %q' "$@")

tar -C "$here" --exclude=apply.sh -czf - . |
  ssh -i "$key" -o IdentitiesOnly=yes "$target" \
    "set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; tar -C \"\$d\" -xzf -; sudo bash \"\$d/bootstrap.sh\"$args"
