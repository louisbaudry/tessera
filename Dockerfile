# One image: the API server plus the built SPA (backlog #36, v1-spec.md §2.5).
#
#   docker build -t tessera .
#   docker run -p 3400:3400 -v tessera-data:/data tessera
#   docker run --rm -v tessera-data:/data tessera \
#     node dist/create-account.js you@example.com 'a-long-password'
#
# Everything the server writes — platform.sqlite and every account's
# projects and memories — is under /data, the one volume. HTTPS is not
# terminated here: the host's proxy or platform does that (the deploy
# target is chosen outside this file).

FROM node:22-bookworm-slim AS build
# better-sqlite3 ships prebuilt binaries; the toolchain is the fallback
# for a platform without one, so a missing prebuild is a slow build, not a
# failed one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# The pnpm version is the one package.json pins.
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 # The server and its production dependencies only, with the workspace
 # packages copied in as built. `--no-optional` leaves out the bench's
 # approximate vector index (hnswlib-node, a node-gyp build the server
 # never loads).
 && pnpm --filter @cat-tool/server deploy --prod --no-optional --legacy /app

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    CAT_PORT=3400 \
    CAT_DB_PATH=/data/platform.sqlite \
    CAT_STORAGE_ROOT=/data/storage \
    CAT_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /app ./
COPY --from=build /src/packages/web/dist ./web
# The base image's unprivileged user owns the volume mount point.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3400
CMD ["node", "dist/main.js"]
