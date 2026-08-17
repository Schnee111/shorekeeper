#!/usr/bin/env bash
# smoke-conflict.sh — smoke conflict detection (TASK-2.3): 2 task bentrok di
# file sama (repo-a lib/math.py). Hasil akhir: 1 done + 1 menunggu (queued)
# lalu selesai sequential TANPA merge paralel; log memuat `conflict-detected`.
# Log: scripts/e2e/logs/smoke-conflict-<date>.log
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

mkdir -p scripts/e2e/logs data
LOG="scripts/e2e/logs/smoke-conflict-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "[smoke-conflict] $(date -Is) start (log: $LOG)"

echo "[smoke-conflict] build packages + reset fixture repo-a"
pnpm -r build >/dev/null
bash scripts/e2e/bootstrap-fixture.sh repo-a

export OMP_BRIDGE_MOCK=1
export OMP_BRIDGE_ALLOWLIST="$ROOT/tests/fixtures/repo-a"
export SHOREKEEPER_VERIFY_CMD="uv run --project $ROOT/apps/agent python -m pytest -q tests -p no:cacheprovider"

echo "[smoke-conflict] ownership claim bentrok → pre-spawn defer → merge sequential"
node scripts/e2e/smoke-conflict.mjs --db "$ROOT/data/tasks-conflict.db"

echo "[smoke-conflict] log memuat conflict-detected:"
grep -c "conflict-detected" "$LOG" >/dev/null

if [ -n "$(git -C "$ROOT/tests/fixtures/repo-a" status --porcelain)" ]; then
  echo "[smoke-conflict] GAGAL: repo-a kotor"
  exit 1
fi

echo "[smoke-conflict] exit 0 — SMOKE-CONFLICT PASS"
echo "[smoke-conflict] $(date -Is) end"
