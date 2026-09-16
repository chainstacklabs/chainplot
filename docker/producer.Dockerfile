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
COPY src ./src
# The viewer bundle is a build artifact copied in, not rebuilt here, so the
# producer image stays CLI + rindexer. Build it on the host first (`pnpm build`).
COPY viewer/dist ./viewer/dist
RUN pnpm build:cli
COPY --from=rindexer /app/rindexer /usr/local/bin/rindexer
# Pre-install the DuckDB postgres extension so export works without network.
RUN node --input-type=module -e "import { DuckDBInstance } from '@duckdb/node-api'; const db = await DuckDBInstance.create(':memory:'); const c = await db.connect(); await c.run('INSTALL postgres; LOAD postgres;');" && mkdir -p /workspace/.duckdb
ENV DUCKDB_EXTENSION_DIRECTORY=/root/.duckdb/extensions
# A `chainplot` on PATH, so the documented
# `docker compose exec producer chainplot <command> --json` is the real command.
RUN printf '#!/bin/sh\nexec node /app/dist/cli/main.js "$@"\n' \
      > /usr/local/bin/chainplot \
  && chmod +x /usr/local/bin/chainplot
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
