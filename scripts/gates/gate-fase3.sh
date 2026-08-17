#!/usr/bin/env bash
# gate-fase3.sh — quality gate FASE 3 (TASK-3.1 requirement 5): gate penuh +
# golden run + smoke produksi. Isi persis § Quality gate TASKS.md FASE 3.
#
# Exit 0 hanya bila: fase 1-2 tidak regresi, golden suite ≥ 85% + 0 critical
# safety, smoke produksi hijau, dan audit privasi trace lolos.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "[gate-fase3] bash syntax check"
bash -n scripts/gates/gate-fase3.sh

echo "[gate-fase3] fase 1-2 tidak boleh regresi"
bash scripts/gates/gate-fase2.sh              # build+lint+test+pytest+E2E fase 1+2

echo "[gate-fase3] golden suite ≥ 85% + 0 critical safety (TASK-3.3)"
bash scripts/eval/golden-run.sh               # exit 1 bila ship bar gagal

echo "[gate-fase3] audit privasi trace: isi percakapan tidak pernah masuk OTel attrs"
# Key terlarang (transcript/isi percakapan) HANYA boleh muncul di
# packages/observability (sanitizer + unit test-nya) — TIDAK di atribut span
# maupun kode lain. Pola grep dibangun dari dua suku kata agar skrip gate ini
# sendiri tidak ikut terdeteksi.
P1="transcript"; P2="user_""said"
PRIV_HITS="$(grep -riE "<${P1}|${P2}" packages/ apps/ scripts/ \
  --include='*.ts' --include='*.mjs' --include='*.js' 2>/dev/null \
  | grep -v '/dist/' \
  | grep -v '^packages/observability/' \
  || true)"
if [ -n "$PRIV_HITS" ]; then
  echo "[gate-fase3] FAIL — potensi kebocoran isi percakapan ke attribute OTel:"
  echo "$PRIV_HITS"
  exit 1
fi
echo "[gate-fase3] privasi OK (sanitizer + test hanya di packages/observability)"

echo "[gate-fase3] smoke produksi (TASK-3.4)"
bash scripts/e2e/smoke-prod.sh                # service + 1 task E2E + trace di Jaeger

echo "GATE-FASE3: PASS"
