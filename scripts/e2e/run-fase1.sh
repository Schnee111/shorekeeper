#!/usr/bin/env bash
# run-fase1.sh — E2E FASE 1 (TASK-1.5): jalur utuh 1 task.
#
# Alur: build bridge+store → bootstrap fixture repo-a (buggy) → DB fresh
# (data/tasks-e2e.db) → seed 1 task lane=debug contract "fix fungsi add" →
# pipeline (delegate via runTask MOCK → artifact diff → merge kerja worker ke
# fixture → verifier rerun pytest fixture → done+summary) → end-state assertion.
#
# Exit 0 hanya jika SEMUA tahap benar; gagal → exit non-0 DENGAN nama stage
# (log: scripts/e2e/logs/run-fase1-<date>.log). Idempotent: DB di-fresh tiap run.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

# E2E_BREAK_FIXTURE=1 → mode test negatif: fixture dipecah sementara setelah bootstrap,
# pipeline HARUS gagal (VERIFY_FAILED), fixture di-rollback saat exit.
NEGATIVE="${E2E_BREAK_FIXTURE:-0}"
DB="${E2E_DB:-$ROOT/data/tasks-e2e.db}"
FIX="$ROOT/tests/fixtures/repo-a"
STAGE="start"

mkdir -p scripts/e2e/logs data
LOG="scripts/e2e/logs/run-fase1-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[e2e-fase1][$(date +%H:%M:%S)] $*"; }

if [ "$NEGATIVE" = "1" ]; then
  trap 'bash scripts/e2e/bootstrap-fixture.sh >/dev/null 2>&1 || true; log "FAILED at stage=$STAGE (fixture di-rollback ke buggy-initial) — log: $LOG"; exit 1' ERR
else
  trap 'log "FAILED at stage=$STAGE — lihat log: $LOG"; exit 1' ERR
fi

log "start (log: $LOG, db: $DB, negative=$NEGATIVE)"

STAGE=build
log "stage=$STAGE — build omp-bridge + task-store"
pnpm --filter omp-bridge build >/dev/null
pnpm --filter task-store build >/dev/null

STAGE=bootstrap-fixture
log "stage=$STAGE — reset fixture repo-a ke buggy-initial"
bash scripts/e2e/bootstrap-fixture.sh

if [ "$NEGATIVE" = "1" ]; then
  STAGE=fixture-break
  log "stage=$STAGE — pecah test fixture sementara (add(2,3) == 6 — salah)"
  sed -i 's/assert add(2, 3) == 5/assert add(2, 3) == 6/' "$FIX/tests/test_math.py"
  git -C "$FIX" -c user.name="Shorekeeper Fixture" -c user.email="fixture@shorekeeper.local" \
    commit -qam "break fixture test temporarily (negative test)"
fi

STAGE=db-fresh
log "stage=$STAGE — DB fresh (hapus $DB*)"
rm -f "$DB" "$DB-wal" "$DB-shm"

STAGE=pipeline
log "stage=$STAGE — seed + delegate + verify + done (mock worker, OMP-001)"
export OMP_BRIDGE_MOCK=1
export OMP_BRIDGE_ALLOWLIST="$ROOT/tests/fixtures/repo-a"
export SHOREKEEPER_VERIFY_CMD="uv run --project $ROOT/apps/agent python -m pytest -q tests -p no:cacheprovider"
node scripts/e2e/run-pipeline.mjs --db "$DB" --repo "$ROOT/tests/fixtures/repo-a"

STAGE=assert-endstate
log "stage=$STAGE — end-state assertion (store + filesystem)"
node scripts/e2e/assert-endstate.mjs --db "$DB"

STAGE=done
log "stage=$STAGE — exit 0 (log: $LOG)"
echo "[e2e-fase1] PASS"