#!/usr/bin/env bash
# test-negative-fase1.sh — test NEGATIF E2E FASE-1 (TASK-1.5 AC).
#
# Jalankan run-fase1.sh dengan E2E_BREAK_FIXTURE=1 (fixture dipecah sementara
# setelah bootstrap oleh run-fase1.sh sendiri; di-rollback di trap exit):
# - run-fase1.sh HARUS exit NON-0 dengan nama stage (log memuat "FAILED at stage=")
# - store mencatat status=failed + error=VERIFY_FAILED (assert-store-failed.mjs)
# - setelah run: fixture bersih (buggy-initial, test asli kembali)
#
# Exit 0 = negative test PASS (run-fase1 memang harus gagal — store membuktikannya).
# Log (memuat VERIFY_FAILED — sengaja) di scripts/e2e/logs/negative/, bukan logs/.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
FIX="$ROOT/tests/fixtures/repo-a"

mkdir -p scripts/e2e/logs/negative
LOG="scripts/e2e/logs/negative/run-fase1-negative-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "[negative][$(date +%H:%M:%S)] start (log: $LOG)"

echo "[negative] menjalankan run-fase1.sh (E2E_BREAK_FIXTURE=1) — DIHARAPKAN gagal (exit non-0)"
set +e
E2E_BREAK_FIXTURE=1 bash scripts/e2e/run-fase1.sh
RC=$?
set -e
echo "[negative] run-fase1.sh exit=$RC"
if [ "$RC" -eq 0 ]; then
  echo "NEGATIVE: FAIL — run-fase1.sh harusnya exit non-0 saat test fixture rusak"
  exit 1
fi
echo "[negative] PASS: run-fase1.sh exit non-0 (stage failure di log run-fase1)"

echo "[negative] memverifikasi store: status=failed, error=VERIFY_FAILED"
node scripts/e2e/assert-store-failed.mjs --db "$ROOT/data/tasks-e2e.db"

echo "[negative] memverifikasi rollback: fixture bersih & test asli kembali"
bash scripts/e2e/bootstrap-fixture.sh
if [ -n "$(git -C "$FIX" status --porcelain)" ]; then
  echo "NEGATIVE: FAIL — fixture tidak bersih setelah rollback"
  exit 1
fi
grep -q "assert add(2, 3) == 5" "$FIX/tests/test_math.py" || {
  echo "NEGATIVE: FAIL — test asli (add(2,3)==5) tidak kembali setelah rollback"
  exit 1
}
echo "[negative] rollback OK — fixture bersih (buggy-initial, test asli kembali)"

# Bersihkan log run-fase1 yang dibuat oleh run negatif ini (memuat VERIFY_FAILED —
# kontrak AC: logs/ top-level hanya memuat run sukses; log negatif asli tetap di logs/negative/)
grep -l "negative=1" scripts/e2e/logs/run-fase1-*.log 2>/dev/null | xargs -r rm -f

echo "NEGATIVE-TEST: PASS"