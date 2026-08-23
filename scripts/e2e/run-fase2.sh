#!/usr/bin/env bash
# run-fase2.sh — E2E FASE 2 (TASK-2.4): 2–3 task paralel + konflik + gagal
# berulang. Bukti utama Fase 2 (dipanggil gate-fase2.sh).
#
# Alur: build semua package → bootstrap fixture repo-a/b/c → DB + ownership
# fresh → seed skenario A (3 independen) + B (2 bentrok) + C (timeout berulang)
# lewat WorkerManager + MergeOrchestrator → end-state assertion.
#
# Exit 0 hanya jika SEMUA skenario benar; gagal → exit non-0 dengan nama stage.
# Log: scripts/e2e/logs/run-fase2-<date>.log. Deterministik (fresh DB per run).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

DB="${E2E_DB:-$ROOT/data/tasks-fase2.db}"
STAGE="start"

mkdir -p scripts/e2e/logs data
LOG="scripts/e2e/logs/run-fase2-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[e2e-fase2][$(date +%H:%M:%S)] $*"; }
trap 'log "FAILED at stage=$STAGE — lihat log: $LOG"; exit 1' ERR

log "start (log: $LOG, db: $DB)"

STAGE=build
log "stage=$STAGE — build semua package"
pnpm -r build >/dev/null

STAGE=bootstrap-fixture
log "stage=$STAGE — reset fixture repo-a/b/c ke buggy-initial"
bash scripts/e2e/bootstrap-fixture.sh all

STAGE=db-fresh
log "stage=$STAGE — DB + ownership + worktrees fresh"
rm -f "$DB" "$DB-wal" "$DB-shm"
rm -f "$ROOT/data/ownership.json"
rm -rf "$ROOT/data/worktrees"

STAGE=pipeline
log "stage=$STAGE — skenario A (paralel) + B (konflik) + C (gagal berulang)"
export OMP_BRIDGE_MOCK=1
export OMP_BRIDGE_ALLOWLIST="$ROOT/tests/fixtures/repo-a:$ROOT/tests/fixtures/repo-b:$ROOT/tests/fixtures/repo-c"
export SHOREKEEPER_VERIFY_CMD="uv run --project $ROOT/apps/agent python -m pytest -q tests -p no:cacheprovider"
node scripts/e2e/run-fase2.mjs --db "$DB"

STAGE=assert-endstate
log "stage=$STAGE — end-state assertion (store + ownership + git)"
node scripts/e2e/assert-fase2.mjs --db "$DB"

STAGE=isolation
log "stage=$STAGE — fixture bersih dari sisa worker"
for R in repo-a repo-b repo-c; do
  if [ -n "$(git -C "$ROOT/tests/fixtures/$R" status --porcelain)" ]; then
    log "GAGAL: $R kotor"
    exit 1
  fi
done

STAGE=done
log "stage=$STAGE — exit 0 (log: $LOG)"
echo "[e2e-fase2] PASS"
