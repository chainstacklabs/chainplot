# Producer image: chainplot CLI + the pinned rindexer binary (linux/amd64).
# The rindexer binary is copied from the pinned upstream image; no docker.sock.
FROM ghcr.io/joshstevens19/rindexer@sha256:9b33da8cea740b74ebfdfd3932682e8ceab79cbcf2eb3a7ca0863ac413794dd7 AS rindexer

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends libssl3 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY schemas ./schemas
# `init` and `templates list` read these at runtime.
COPY templates ./templates
COPY src ./src
# The viewer bundle is a build artifact copied in, not rebuilt here, so the
# producer image stays CLI + rindexer. Build it on the host first (`pnpm build`).
COPY viewer/dist ./viewer/dist
RUN pnpm build:cli
COPY --from=rindexer /app/rindexer /usr/local/bin/rindexer
# The CLI runs as whichever user owns the mounted project (see the shim
# below), so HOME — where DuckDB looks for its extensions — has to be a
# directory any user can read and write, not /root.
ENV HOME=/home/chainplot
ENV DUCKDB_EXTENSION_DIRECTORY=/home/chainplot/.duckdb/extensions
# Pre-install the DuckDB postgres extension so export works without network.
RUN mkdir -p /home/chainplot \
  && node --input-type=module -e "import { DuckDBInstance } from '@duckdb/node-api'; const db = await DuckDBInstance.create(':memory:'); const c = await db.connect(); await c.run('INSTALL postgres; LOAD postgres;');" \
  && chmod -R a+rwX /home/chainplot
# `chainplot` on PATH, so the documented
# `docker compose exec producer chainplot <command> --json` is the real command.
#
# It drops to the uid:gid that owns /workspace before running the CLI. The
# files it writes into the bind-mounted project — .chainplot/, dist/ — are then
# the host user's to read and delete, not root's. Where the mount is owned by
# root this is a no-op.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'owner=$(stat -c %u:%g /workspace 2>/dev/null || echo 0:0)' \
      'if [ "$owner" = "0:0" ]; then exec node /app/dist/cli/main.js "$@"; fi' \
      'exec setpriv --reuid="${owner%%:*}" --regid="${owner##*:}" --clear-groups node /app/dist/cli/main.js "$@"' \
      > /usr/local/bin/chainplot \
  && chmod +x /usr/local/bin/chainplot
ENTRYPOINT ["/usr/local/bin/chainplot"]
