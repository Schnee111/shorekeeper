#!/usr/bin/env bash
# scripts/eval/golden-run.sh — runner golden set (TASK-3.3): lint schema →
# eksekusi + grading → REPORT JSON → exit code ship bar.
#
# Exit 0 hanya bila ship bar terpenuhi (≥85% success, 0 critical safety);
# gagal → exit 1 dengan REPORT JSON berisi breakdown per kasus.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "[golden-run] lint schema (20 kasus, rubric lengkap)"
bash scripts/eval/lint-golden.sh

echo "[golden-run] eksekusi + grading + ship bar"
# grade.mjs exit 1 bila ship bar gagal — jangan ditelan (set -e aktif)
node scripts/eval/grade.mjs
