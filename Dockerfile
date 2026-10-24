# syntax=docker/dockerfile:1
# Release images (D-075): `api`, `worker` and `web`, built from one shared build stage.
#   docker build --target api --build-arg ERP_VERSION=<tree hash> -t erp-api:<tree hash> .

FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Dependencies first, so this layer is reused while only source code changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
# The browser apps get the release and Sentry's erp-web DSN at build time (W0-06, D-086). With a Sentry token
# (a BuildKit secret, never stored in the image), their source maps are uploaded to Sentry and deleted.
ARG ERP_VERSION=dev
ARG SENTRY_DSN_WEB=
ARG SENTRY_ORG=
ENV VITE_ERP_VERSION=$ERP_VERSION VITE_SENTRY_DSN=$SENTRY_DSN_WEB
RUN --mount=type=secret,id=sentry_auth_token,required=false     SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" SENTRY_ORG="$SENTRY_ORG"     pnpm --filter @erp/api --filter @erp/worker --filter @erp/pos --filter @erp/backoffice build
# Production copies: dist + external dependencies only. Internal packages are bundled into dist (D-071).
RUN pnpm --filter @erp/api deploy --prod --legacy /out/api \
 && pnpm --filter @erp/worker deploy --prod --legacy /out/worker

FROM node:24-alpine AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM node-runtime AS api
COPY --from=build --chown=root:root /out/api/package.json ./
COPY --from=build --chown=root:root /out/api/node_modules ./node_modules
COPY --from=build --chown=root:root /out/api/dist ./dist
# SQL migrations, found next to dist/ by the bundled migrate step (D-078).
COPY --from=build --chown=root:root /repo/packages/db/migrations ./migrations
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ARG ERP_VERSION=dev
ENV ERP_VERSION=$ERP_VERSION
LABEL org.opencontainers.image.version=$ERP_VERSION
# instrument.js starts OpenTelemetry before the app loads (W0-06, D-086).
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]

FROM node-runtime AS worker
COPY --from=build --chown=root:root /out/worker/package.json ./
COPY --from=build --chown=root:root /out/worker/node_modules ./node_modules
COPY --from=build --chown=root:root /out/worker/dist ./dist
ARG ERP_VERSION=dev
ENV ERP_VERSION=$ERP_VERSION
LABEL org.opencontainers.image.version=$ERP_VERSION
CMD ["node", "dist/main.js"]

FROM caddy:2.11.7-alpine AS web
# Runs unprivileged; Caddy's own state goes to /tmp (a tmpfs in compose).
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
# The official binary carries a file capability (bind ports < 1024). With no-new-privileges and no
# capabilities, exec of such a binary is refused. Ports 8080/8081 don't need it: copy drops it.
RUN cp /usr/bin/caddy /tmp/caddy && mv /tmp/caddy /usr/bin/caddy
COPY infra/app/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/pos/dist /srv/pos
COPY --from=build /repo/apps/backoffice/dist /srv/backoffice
USER nobody
EXPOSE 8080 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null && wget -qO- http://127.0.0.1:8081/ >/dev/null || exit 1
ARG ERP_VERSION=dev
LABEL org.opencontainers.image.version=$ERP_VERSION
