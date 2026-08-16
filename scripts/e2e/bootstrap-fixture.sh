#!/usr/bin/env bash
# bootstrap-fixture.sh — buat/reset deterministik tests/fixtures/repo-a (TASK-1.3).
#
# repo-a adalah mini git repo dengan 1 file Python (lib/math.py, fungsi `add` SALAH)
# + 1 test pytest (merah). State awal di-tag `buggy-initial`; setiap pemanggilan
# me-reset repo ke state buggy agar E2E deterministik (fixture frozen, no network).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
FIX="$ROOT/tests/fixtures/repo-a"

if [ ! -d "$FIX/.git" ]; then
  mkdir -p "$FIX/lib" "$FIX/tests"
  cat > "$FIX/lib/math.py" <<'PY'
"""lib/math.py — fixture repo-a (TASK-1.3). Fungsi `add` sengaja salah (bug)."""


def add(a: int, b: int) -> int:
    return a - b  # BUG: seharusnya a + b
PY
  cat > "$FIX/tests/conftest.py" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
PY
  cat > "$FIX/tests/test_math.py" <<'PY'
from lib.math import add


def test_add_positives():
    assert add(2, 3) == 5


def test_add_zero():
    assert add(0, 0) == 0
PY
  printf '__pycache__/\n.pytest_cache/\n' > "$FIX/.gitignore"

  git -C "$FIX" init -q -b main
  git -C "$FIX" config user.name "Shorekeeper Fixture"
  git -C "$FIX" config user.email "fixture@shorekeeper.local"
  GIT_AUTHOR_DATE=2026-08-17T00:00:00Z GIT_COMMITTER_DATE=2026-08-17T00:00:00Z \
    git -C "$FIX" add -A
  GIT_AUTHOR_DATE=2026-08-17T00:00:00Z GIT_COMMITTER_DATE=2026-08-17T00:00:00Z \
    git -C "$FIX" commit -qm "fixture repo-a: fungsi add buggy (pytest merah)"
  git -C "$FIX" tag buggy-initial
  echo "[bootstrap-fixture] repo-a dibuat (buggy-initial)"
else
  # reset deterministik ke state buggy (hapus sisa fix/merge run sebelumnya)
  git -C "$FIX" worktree prune
  if git -C "$FIX" rev-parse --verify -q buggy-initial >/dev/null; then
    git -C "$FIX" reset -q --hard buggy-initial
  else
    git -C "$FIX" reset -q --hard HEAD
  fi
  git -C "$FIX" clean -qfd
  echo "[bootstrap-fixture] repo-a di-reset ke buggy-initial"
fi