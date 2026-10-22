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

echo "== roles (D-078)"
# erp_owner owns the schema and runs migrations; erp_app is what the apps use (no BYPASSRLS, owns nothing).
for role in erp_owner erp_app; do
  file=$secrets/$role-password
  if [[ ! -f $file ]]; then
    openssl rand -hex 24 | tr -d '\n' >"$file"
    chown 999:999 "$file"
    chmod 600 "$file"
  fi
done
owner_pw=$(cat "$secrets/erp_owner-password")
app_pw=$(cat "$secrets/erp_app-password")
docker exec -i -u postgres "erp-$env-db" psql -X -q -v ON_ERROR_STOP=1 -d erp \
  -v owner_pw="$owner_pw" -v app_pw="$app_pw" <<'SQL' >/dev/null
SELECT format('CREATE ROLE erp_owner LOGIN') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_owner') \gexec
SELECT format('CREATE ROLE erp_app LOGIN NOBYPASSRLS') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') \gexec
ALTER ROLE erp_owner PASSWORD :'owner_pw';
ALTER ROLE erp_app PASSWORD :'app_pw' NOBYPASSRLS;
REVOKE CONNECT ON DATABASE erp FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE erp TO erp_owner;
GRANT CONNECT ON DATABASE erp TO erp_app;
SQL
# Read by docker compose as the deploy user: app.env for the running apps, migrate.env only for the migrate step.
umask 077
printf 'DATABASE_URL=postgres://erp_app:%s@erp-%s-db:5432/erp\n' "$app_pw" "$env" >"/srv/erp/$env/app.env.new"
printf 'MIGRATION_DATABASE_URL=postgres://erp_owner:%s@erp-%s-db:5432/erp\n' "$owner_pw" "$env" >"/srv/erp/$env/migrate.env.new"
for f in app.env migrate.env; do
  chown deploy:deploy "/srv/erp/$env/$f.new"
  mv "/srv/erp/$env/$f.new" "/srv/erp/$env/$f"
done
umask 022
echo "roles ready; wrote /srv/erp/$env/app.env and migrate.env"

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
