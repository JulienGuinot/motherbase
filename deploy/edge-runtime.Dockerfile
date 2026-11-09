# syntax=docker/dockerfile:1
FROM denoland/deno:2.9.0

WORKDIR /app
COPY deploy/edge-runtime/ ./
RUN deno cache main.ts runner.ts

USER deno
EXPOSE 9000
# --allow-all for the sidecar itself: --allow-run already amounts to it, and
# the memory watchdog reads /proc, which Deno only allows under --allow-all.
# The workers it spawns stay on their own narrow flags (pool.ts).
CMD ["deno", "run", "--allow-all", "--no-prompt", "main.ts"]
