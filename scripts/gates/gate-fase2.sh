#!/usr/bin/env bash
# gate-fase2.sh — quality gate FASE 2 (TASK-2.1): regresi fase 1 + E2E fase 2.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "[gate-fase2] fase 1 regression"
bash scripts/gates/gate-fase1.sh          # fase 1 tidak boleh regresi

echo "[gate-fase2] E2E fase 2 (2–3 task paralel)"
bash scripts/e2e/run-fase2.sh             # E2E 2–3 task paralel (TASK-2.4)

echo "GATE-FASE2: PASS"