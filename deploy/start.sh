#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

build=0
seed=0

for arg in "$@"; do
  case "$arg" in
    --build) build=1 ;;
    --seed) seed=1 ;;
    -h|--help)
      echo "Usage: ./deploy/start.sh [--build] [--seed]"
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

info "Starting $(stack_mode) stack"
start_proxy_if_needed

if [ "$build" = "1" ]; then
  stack_compose up -d --build
else
  stack_compose up -d
fi

if [ "$seed" = "1" ]; then
  seed_admin
fi

info "Stack is running"
