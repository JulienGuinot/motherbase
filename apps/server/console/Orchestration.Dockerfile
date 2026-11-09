ARG CONSOLE_IMAGE=motherbase-console:1.0.0
ARG DOCKER_CLI_IMAGE=docker:27-cli

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

# Reuse the already-built Console application; only this internal daemon image
# receives the Docker CLI and Compose plugin.
FROM ${CONSOLE_IMAGE}
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
CMD ["node", "./apps/server/dist/console/orchestration/server.js"]
