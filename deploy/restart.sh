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
      echo "Usage: ./deploy/restart.sh [--build] [--seed]"
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

bash "$repo_root/deploy/stop.sh"

if [ "$build" = "1" ] && [ "$seed" = "1" ]; then
  bash "$repo_root/deploy/start.sh" --build --seed
elif [ "$build" = "1" ]; then
  bash "$repo_root/deploy/start.sh" --build
elif [ "$seed" = "1" ]; then
  bash "$repo_root/deploy/start.sh" --seed
else
  bash "$repo_root/deploy/start.sh"
fi
