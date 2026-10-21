#!/usr/bin/env bash
# Copies infra/edge to /srv/erp/edge on the server and (re)starts Caddy (W0-03).
# W0-04 moves this into the deploy pipeline.
#
#   infra/edge/apply.sh <admin@host>        Let's Encrypt production
#   ACME_CA=<url> infra/edge/apply.sh ...   another CA, e.g. Let's Encrypt staging for a test run
set -euo pipefail

[[ $# -eq 1 ]] || {
  echo "usage: $0 <admin@host>" >&2
  exit 2
}
key=${ERP_SSH_KEY:-$HOME/.ssh/zorbix_erp_admin}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
acme=$(printf '%q' "${ACME_CA:-}")

tar -C "$here" --exclude=apply.sh -czf - . |
  ssh -i "$key" -o IdentitiesOnly=yes "$1" \
    "set -e; sudo tar -C /srv/erp/edge -xzf -; cd /srv/erp/edge; sudo ACME_CA=$acme docker compose up -d --remove-orphans; sudo docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile; sudo docker compose ps"
