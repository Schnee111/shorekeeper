#!/usr/bin/env bash
# scripts/eval/test-corrupt.sh — uji mekanik ship bar (TASK-3.3 AC):
# injeksi 1 kasus rusak (expected_outcome dibalik via GOLDEN_CORRUPT_CASE) →
# skor HARUS turun dan bar menolak sesuai jenis kasus:
# - kasus SAFETY rusak → critical safety failure → SHIP_BLOCKED + exit 1
#   (default gs-x01: inilah enforcement 0-critical pada ship bar).
# - kasus non-safety rusak → skor turun (mis. 100%→95%) dan kasus tercatat
#   FAIL di REPORT (bar success ≥85% masih bisa tahan 1 kasus non-kritis —
#   sesuai desain; penolakan keras lewat jalur safety).
#
# Bukti mekanik bahwa bar tidak bisa diloloskan oleh kasus safety yang salah.
set -euo pipefail
cd "$(dirname "$0")/../.."

VICTIM="${1:-gs-x01}"
echo "[test-corrupt] injeksi kasus rusak: $VICTIM (expected_outcome dibalik)"
set +e
GOLDEN_CORRUPT_CASE="$VICTIM" node scripts/eval/grade.mjs
CODE=$?
set -e

R="$(ls -1t docs/golden-set/REPORT-*.json | head -1)"
RATE="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$R','utf8')).ship_bar.success_rate)")"
DECISION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$R','utf8')).ship_bar.decision)")"
VFAIL="$(node -e "
const r = JSON.parse(require('fs').readFileSync('$R','utf8'));
const c = r.cases.find((x) => x.id === process.argv[1]);
console.log(c && c.pass === false ? 'failed' : 'passed');
" "$VICTIM")"

echo "[test-corrupt] report=$R success_rate=$RATE decision=$DECISION victim=$VFAIL exit=$CODE"
if [ "$VFAIL" != "failed" ]; then
  echo "[test-corrupt] FAIL — kasus yang dirusak tidak terdeteksi gagal"
  exit 1
fi
if [ "$DECISION" = "SHIP_BLOCKED" ] && [ "$CODE" = "1" ]; then
  echo "[test-corrupt] PASS — bar menolak kasus safety rusak (exit 1, SHIP_BLOCKED, skor turun ke $RATE)"
  exit 0
fi
echo "[test-corrupt] FAIL — expected SHIP_BLOCKED + exit 1 untuk korban safety, dapat decision=$DECISION exit=$CODE"
exit 1
