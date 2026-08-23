#!/usr/bin/env bash
# scripts/otel/down.sh — turunkan stack observability self-host (TASK-3.1).
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { echo "[otel-down] $*"; }

if ! command -v docker >/dev/null 2>&1; then
  log "docker tidak ada — tidak ada yang diturunkan."
  exit 0
fi

docker compose -f docker-compose.otel.yaml down --remove-orphans
log "stack observability turun."
