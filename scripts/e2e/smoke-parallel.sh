#!/usr/bin/env bash
# smoke-parallel.sh — smoke worker manager (TASK-2.2 CLU): 3 task independen
# kecil paralel di 3 fixture repo (repo-a/b/c). Pool ≤ 3, merge sequential via
# orchestrator, semua done + 3 squash commit. Sampai E2E penuh TASK-2.4.
# Log: scripts/e2e/logs/smoke-parallel-<date>.log
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

mkdir -p scripts/e2e/logs data
LOG="scripts/e2e/logs/smoke-parallel-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "[smoke-parallel] $(date -Is) start (log: $LOG)"

echo "[smoke-parallel] build packages + bootstrap fixture repo-a/b/c"
pnpm -r build >/dev/null
bash scripts/e2e/bootstrap-fixture.sh all

export OMP_BRIDGE_MOCK=1
export OMP_BRIDGE_ALLOWLIST="$ROOT/tests/fixtures/repo-a:$ROOT/tests/fixtures/repo-b:$ROOT/tests/fixtures/repo-c"
export SHOREKEEPER_VERIFY_CMD="uv run --project $ROOT/apps/agent python -m pytest -q tests -p no:cacheprovider"

echo "[smoke-parallel] snapshot state monorepo (untuk deteksi side-effect run)"
SNAP_BEFORE="$(git status --porcelain)"

echo "[smoke-parallel] manager pool ≤ 3 + merge gate sequential (3 task independen)"
node scripts/e2e/smoke-parallel.mjs --db "$ROOT/data/tasks-parallel.db"

echo "[smoke-parallel] verifikasi isolasi: fixture & monorepo bersih dari side-effect run"
for R in repo-a repo-b repo-c; do
  if [ -n "$(git -C "$ROOT/tests/fixtures/$R" status --porcelain)" ]; then
    echo "[smoke-parallel] GAGAL: $R kotor"
    exit 1
  fi
done
SNAP_AFTER="$(git status --porcelain)"
if [ "$SNAP_BEFORE" != "$SNAP_AFTER" ]; then
  echo "[smoke-parallel] GAGAL: monorepo berubah akibat run (selisih git status):"
  diff <(echo "$SNAP_BEFORE") <(echo "$SNAP_AFTER") || true
  exit 1
fi

echo "[smoke-parallel] exit 0 — SMOKE-PARALLEL PASS"
echo "[smoke-parallel] $(date -Is) end"
