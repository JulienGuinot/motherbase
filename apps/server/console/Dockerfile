# Console image. Docker tooling intentionally lives only in the separate
# Orchestration.Dockerfile image.
ARG DEPS_IMAGE=motherbase-deps:1.0.0


FROM ${DEPS_IMAGE}
# No WORKDIR here: the deps image already sits at /app.
# node_modules already installed in the deps image; .dockerignore keeps this
# COPY from clobbering it. `npm run build` (turbo) compiles the server and builds
# the studio, which only this image serves (apps/studio/.next).
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["node", "./apps/server/dist/console/server.js"]
