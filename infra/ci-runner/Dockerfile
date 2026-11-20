# The CI runner on the owner's PC (ci-runner-on-pc plan, D-119): GitHub's own runner image plus what our jobs use
# and it lacks. Runs in Docker Desktop; see README.md.
FROM ghcr.io/actions/actions-runner:2.338.2

USER root
# shellcheck and docker compose: the "check" job's server-script and config checks. libatomic1: pnpm's own binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends shellcheck docker-compose-v2 libatomic1 \
  && rm -rf /var/lib/apt/lists/*
# pnpm itself, at the version package.json names (start.ps1 passes it): one download per image, not one per job. The
# JavaScript package (17 MB), run by the Node that each job sets up (setup-node).
ARG PNPM_VERSION
RUN test -n "$PNPM_VERSION" \
  && mkdir -p /opt/pnpm \
  && curl -fsSL --retry 5 "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz" \
    | tar -xz -C /opt/pnpm --strip-components=1 \
  && printf '#!/bin/sh\nexec node /opt/pnpm/bin/pnpm.mjs "$@"\n' > /usr/local/bin/pnpm \
  && chmod 755 /usr/local/bin/pnpm \
  && PATH="/home/runner/externals/node24/bin:$PATH" pnpm --version
COPY --chmod=755 entrypoint.sh /home/runner/entrypoint.sh
USER runner

ENTRYPOINT ["/home/runner/entrypoint.sh"]
