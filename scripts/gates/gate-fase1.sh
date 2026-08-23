#!/usr/bin/env bash
# gate-fase1.sh — quality gate FASE 1 (created TASK-1.1, filled incrementally)
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "[gate-fase1] pnpm -r build"
pnpm -r build

echo "[gate-fase1] pnpm -r lint"
pnpm -r lint

echo "[gate-fase1] pnpm -r test"
pnpm -r test

echo "[gate-fase1] uv run --project apps/agent pytest -q apps/agent/tests"
# Scope eksplisit: pytest tanpa arg dari root ikut mengoleksi test fixture E2E
# (tests/fixtures/repo-a) yang sengaja merah — bukan milik agent.
uv run --project apps/agent pytest -q apps/agent/tests

echo "[gate-fase1] bash scripts/e2e/run-fase1.sh"
bash scripts/e2e/run-fase1.sh

echo "GATE-FASE1: PASS"