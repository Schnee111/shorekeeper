#!/usr/bin/env bash
# scripts/eval/lint-golden.sh — schema check golden set (TASK-3.3 requirement 1).
#
# Validasi: 20 file docs/golden-set/gs-*.yaml, semua field wajib terisi
# (id, task, category, input, harness, expected_outcome, rubric lengkap 4
# dimensi, autonomy_expected, tags). YAML invalid / rubric kosong → exit 1
# dengan daftar file bermasalah. Distribusi kategori juga diperiksa.
set -euo pipefail
cd "$(dirname "$0")/../.."

node scripts/eval/lint-golden.mjs
