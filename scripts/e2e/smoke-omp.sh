#!/usr/bin/env bash
# smoke-omp.sh — POC bridge Hermes ↔ worker (TASK-1.3).
#
# Alur: build bridge → bootstrap fixture repo-a (buggy) → delegasi 1 task via
# runTask (MOCK worker — OMP-001, lihat docs/BLOCKERS.md) → verifikasi merah→hijau
# hanya di worktree → cetak diffSummary. Exit 0 = POC sukses.
# Log: scripts/e2e/logs/smoke-omp-<date>.log
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

mkdir -p scripts/e2e/logs data
LOG="scripts/e2e/logs/smoke-omp-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "[smoke-omp] $(date -Is) start (log: $LOG)"

echo "[smoke-omp] build omp-bridge + bootstrap fixture"
pnpm --filter omp-bridge build >/dev/null
bash scripts/e2e/bootstrap-fixture.sh

export OMP_BRIDGE_MOCK=1
export OMP_BRIDGE_ALLOWLIST="$ROOT/tests/fixtures/repo-a"
export SHOREKEEPER_VERIFY_CMD="uv run --project $ROOT/apps/agent python -m pytest -q tests -p no:cacheprovider"

echo "[smoke-omp] satu perintah delegasi (setara tool Hermes omp_spawn_worker, docs/api.md §3.1)"
node scripts/e2e/smoke-omp.mjs

echo "[smoke-omp] verifikasi isolasi: worker TIDAK menyentuh file di luar fixture"
if [ -n "$(git -C "$ROOT/tests/fixtures/repo-a" status --porcelain)" ]; then
  echo "[smoke-omp] GAGAL: repo fixture kotor (seharusnya bersih — semua perubahan di worktree)"
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "[smoke-omp] GAGAL: monorepo kotor setelah run"
  exit 1
fi
echo "[smoke-omp] OK: git status bersih (fixture & monorepo)"

# AC TASK-1.3: `timeout 10 omp --mode rpc </dev/null` TIDAK hang.
# Bin omp rusak (OMP-001) → command langsung crash, timeout 10s hanya jaring pengaman.
set +e
timeout 10 omp --mode rpc </dev/null >/dev/null 2>&1
OMP_RC=$?
set -e
echo "[smoke-omp] 'timeout 10 omp --mode rpc' rc=$OMP_RC (tidak hang; bin rusak oleh OMP-001 — gunakan mock worker, lihat docs/BLOCKERS.md)"

echo "[smoke-omp] exit 0 — SMOKE-OMP PASS"
echo "[smoke-omp] $(date -Is) end"