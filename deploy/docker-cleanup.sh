#!/usr/bin/env bash

docker_cleanup_notice() {
  if declare -F info >/dev/null 2>&1; then
    info "$*"
  elif declare -F warn >/dev/null 2>&1; then
    warn "$*"
  else
    echo "==> $*"
  fi
}

container_projects() {
  local ids="$1"
  local id project

  [ -n "$ids" ] || return 0
  for id in $ids; do
    project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$id" 2>/dev/null || true)"
    [ -n "$project" ] && [ "$project" != "<no value>" ] && printf '%s\n' "$project"
  done | sort -u
}

remove_containers_by_project() {
  local project="$1"
  local ids

  ids="$(docker ps -aq --filter "label=com.docker.compose.project=${project}" 2>/dev/null || true)"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
}

remove_volumes_by_project() {
  local project="$1"
  local volumes volume

  volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=${project}" 2>/dev/null || true)"
  [ -n "$volumes" ] || return 0
  for volume in $volumes; do
    docker volume rm "$volume" >/dev/null
  done
}

remove_compose_project_data() {
  local project="$1"

  [ -n "$project" ] || return 0
  docker_cleanup_notice "Removing Docker containers and volumes for Compose project: ${project}"
  remove_containers_by_project "$project"
  remove_volumes_by_project "$project"
}

remove_volume_stack_data() {
  local volume="$1"
  local project ids

  project="$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' "$volume" 2>/dev/null || true)"
  if [ -n "$project" ] && [ "$project" != "<no value>" ]; then
    remove_compose_project_data "$project"
    return
  fi

  ids="$(docker ps -aq --filter "volume=${volume}" 2>/dev/null || true)"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
  docker volume rm "$volume" >/dev/null
}
