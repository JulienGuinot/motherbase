# Multi-stage build for the project API server (apps/server). No UI: the Studio
# ships only in the Console image (apps/server/console/Dockerfile), which
# proxies to each project's API.
#
# Native deps (argon2) are compiled ONCE in the shared
# motherbase-deps image and reused here, see deploy/deps.Dockerfile.
# Build that image first (setup.sh / deploy/build-images.sh do this):
#   docker build -t motherbase-deps:1.0.0 -f deploy/deps.Dockerfile .
ARG DEPS_IMAGE=motherbase-deps:1.0.0

# --- Build: generate Prisma client + compile server (turbo) ---
FROM ${DEPS_IMAGE} AS build
COPY . .
# The `...` suffix builds the server and the workspaces it depends on
# (@motherbase/client, contracts, ai), and skips studio's next build.
RUN npx turbo run build --filter=@motherbase/server...
# Drop devDependencies from the tree copied into the runtime image. Runs AFTER
# the build (tsc/vite need dev deps); prebuilt native addons (argon2) are
# prod deps and survive the prune.
RUN npm prune --omit=dev --legacy-peer-deps
# The studio is not built here, so its sources are dead weight in the runtime.
RUN rm -rf apps/studio

# --- Runtime image (slim: no build toolchain) ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# openssl is required by Prisma's query engine; postgresql-client provides
# pg_dump/psql used by the Backups and Supabase-import features (without it those
# fail at runtime with "spawn pg_dump ENOENT").
#
# Pull the client from the PostgreSQL APT repo (PGDG) rather than Debian's own.
# Bookworm ships client 15, which refuses to dump a newer server ("aborting
# because of server version mismatch"). Client 17 dumps servers 9.2 → 17; a
# client newer than the server always works, the reverse fails.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates gnupg wget \
  && install -d /usr/share/postgresql-common/pgdg \
  && wget -qO /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y --auto-remove wget \
  && rm -rf /var/lib/apt/lists/*
# Drops to the unprivileged `node` account after making the mounted volumes
# writable; see the script for why the chown cannot live in the image.
COPY deploy/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh
ENV NODE_ENV=production
# Hoisted workspace deps (incl. the generated @prisma/client) live at the root
# node_modules; any nested prod deps travel inside apps/. The compiled server
# resolves modules by walking up from apps/server/dist, so this mirror of the
# workspace layout matches how `npm start` resolves locally.
COPY --from=build /app/node_modules ./node_modules
# apps/server/dist (+ prisma schema/migrations, scripts, any nested node_modules).
COPY --from=build /app/apps ./apps
# Workspace packages the server imports at runtime (e.g. @motherbase/contracts).
# node_modules/@motherbase/* are symlinks into these directories; omit them and
# the links dangle at boot with "Cannot find module '@motherbase/contracts'".
COPY --from=build /app/packages ./packages
# Owned by `node` so a volume created from this image starts out writable by
# the account the server runs as. Existing volumes keep their own ownership,
# which is what the entrypoint fixes up.
RUN mkdir -p /app/backups /app/data && chown -R node:node /app/backups /app/data
EXPOSE 5001
ENTRYPOINT ["/usr/local/bin/api-entrypoint.sh"]
# Wait for Postgres, repair the one known failed migration from the 1.0.0
# rollout when present, apply migrations, then start the server. Runs as `node`:
# the entrypoint has already dropped by the time this does.
CMD ["sh", "-c", "node apps/server/scripts/wait-for-db.js && node apps/server/scripts/run-migrations.js && node apps/server/dist/app.js"]
