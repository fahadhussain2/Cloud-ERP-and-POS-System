#!/usr/bin/env bash
# Runs on the server, as root, from apply.sh (W0-05, D-076): build the image, start the database,
# and for prod create the backup stanza, check archiving and install the backup timers.
set -euo pipefail

env=$1
src=$2
[[ $env == prod || $env == staging ]] || {
  echo "environment must be prod or staging" >&2
  exit 2
}

echo "== image"
docker build -q -t erp-postgres:17.9 "$src" >/dev/null
docker run --rm erp-postgres:17.9 pgbackrest version

echo "== tools"
install -m 755 "$src/bin/erp-db" /usr/local/sbin/erp-db
secrets=/srv/erp/$env/db-secrets
install -d -m 700 -o 999 -g 999 "$secrets"
if [[ ! -f $secrets/postgres-password ]]; then
  # Superuser password for network logins. Admins use `docker exec … psql` over the local socket instead.
  openssl rand -base64 32 | tr -d '\n' >"$secrets/postgres-password"
  chown 999:999 "$secrets/postgres-password"
  chmod 600 "$secrets/postgres-password"
fi
if [[ $env == prod && ! -f $secrets/pgbackrest.conf ]]; then
  echo "Backup secrets are missing. The owner runs:  ssh -t admin@<server> sudo erp-db secrets" >&2
  exit 1
fi

echo "== database"
docker compose -p "erp-$env-db" --env-file "$src/$env.env" -f "$src/compose.yaml" up -d --wait
docker exec -u postgres "erp-$env-db" psql -X -At -d erp -c "SELECT version()"

if [[ $env == prod ]]; then
  echo "== backups"
  # The separate monthly backup (repo2) was dropped to fit B2's free limits (D-077).
  if [[ -f /etc/systemd/system/erp-db-backup-monthly.timer ]]; then
    systemctl disable --now erp-db-backup-monthly.timer
    rm -f /etc/systemd/system/erp-db-backup-monthly.timer /etc/systemd/system/erp-db-backup-monthly.service
  fi
  install -m 644 "$src"/systemd/erp-db-*.service "$src"/systemd/erp-db-*.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now erp-db-backup.timer erp-db-canary.timer erp-db-status.timer
  systemctl list-timers 'erp-db-*' --no-pager
  # Last: these talk to the backup storage. The timers above are already right even if this fails.
  docker exec -u postgres erp-prod-db pgbackrest --stanza=erp stanza-create
  docker exec -u postgres erp-prod-db pgbackrest --stanza=erp check
fi
echo "== done ($env)"
