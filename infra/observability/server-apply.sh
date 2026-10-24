#!/usr/bin/env bash
# Runs on the server, as root, from apply.sh (W0-06, D-086): install erp-obs and the Alloy files, create the
# OpenTelemetry network and the read-only PostgreSQL monitor role, and start Alloy once its secrets exist.
set -euo pipefail

src=$1
DIR=/srv/erp/observability

echo "== files"
install -m 755 "$src/bin/erp-obs" /usr/local/sbin/erp-obs
install -d -m 750 -o root -g deploy "$DIR"
install -m 644 "$src/compose.yaml" "$src/config.alloy" "$DIR/"
# backup.prom from erp-db status; read by Alloy.
install -d -m 755 /srv/erp/metrics

echo "== network"
# The apps send OpenTelemetry to Alloy here. Internal: no way out to the internet.
docker network inspect erp-otel >/dev/null 2>&1 || docker network create --internal erp-otel >/dev/null
echo "erp-otel ready"

echo "== monitor role"
# erp_monitor reads statistics only (pg_monitor); it owns nothing and can't read tenant data.
umask 077
dsn_file=$DIR/postgres.env.new
: >"$dsn_file"
for env in prod staging; do
  secrets=/srv/erp/$env/db-secrets
  file=$secrets/erp_monitor-password
  if [[ ! -f $file ]]; then
    openssl rand -hex 24 | tr -d '\n' >"$file"
    chown 999:999 "$file"
    chmod 600 "$file"
  fi
  pw=$(cat "$file")
  docker exec -i -u postgres "erp-$env-db" psql -X -q -v ON_ERROR_STOP=1 -d erp -v pw="$pw" <<'SQL' >/dev/null
SELECT 'CREATE ROLE erp_monitor LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_monitor') \gexec
ALTER ROLE erp_monitor PASSWORD :'pw' NOBYPASSRLS;
GRANT pg_monitor TO erp_monitor;
GRANT CONNECT ON DATABASE erp TO erp_monitor;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
  upper=$(tr '[:lower:]' '[:upper:]' <<<"$env")
  printf 'PG_%s_DSN=postgres://erp_monitor:%s@erp-%s-db:5432/erp?sslmode=disable\n' "$upper" "$pw" "$env" >>"$dsn_file"
  echo "erp_monitor ready ($env)"
done
mv "$dsn_file" "$DIR/postgres.env"
umask 022

echo "== alloy"
if [[ ! -f $DIR/grafana.env ]]; then
  echo "Grafana Cloud details are missing. The owner runs:  ssh -t admin@<server> sudo erp-obs secrets"
  exit 0
fi
docker compose -p erp-observability -f "$DIR/compose.yaml" up -d
sleep 5
docker inspect -f '{{.State.Status}} (restarts: {{.RestartCount}})' erp-alloy
echo "== done"
