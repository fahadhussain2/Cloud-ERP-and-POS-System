# PostgreSQL with pgBackRest for off-site backups (W0-05, D-076). Built on the server by apply.sh.
FROM postgres:17.9-bookworm
# The official image already has the PostgreSQL apt repository, which ships pgBackRest.
# ca-certificates: pgBackRest verifies the TLS certificate of the backup storage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 750 /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest
COPY postgresql.conf /etc/postgresql/postgresql.conf
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY init/ /docker-entrypoint-initdb.d/
