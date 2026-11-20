# The CI runner on the owner's PC (ci-runner-on-pc plan, D-119): GitHub's own runner image plus what our jobs use
# and it lacks. Runs in Docker Desktop; see README.md.
FROM ghcr.io/actions/actions-runner:2.338.2

USER root
# shellcheck and docker compose: the "check" job's server-script and config checks. libatomic1: pnpm's own binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends shellcheck docker-compose-v2 libatomic1 \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 entrypoint.sh /home/runner/entrypoint.sh
USER runner

ENTRYPOINT ["/home/runner/entrypoint.sh"]
