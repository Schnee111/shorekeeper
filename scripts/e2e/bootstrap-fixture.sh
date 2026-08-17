#!/usr/bin/env bash
# bootstrap-fixture.sh — buat/reset deterministik fixture repos (TASK-1.3, TASK-2.4).
#
# repo-a: mini git repo Python, lib/math.py fungsi `add` SALAH + pytest merah (bug).
# repo-b: lib/feature.py functions `double` NotImplementedError (feature kecil).
# repo-c: lib/greet.py typo "Helllo" (typo fix).
#
# State awal tiap repo di-tag `buggy-initial`; setiap pemanggilan me-reset repo
# ke state tersebut agar E2E deterministik (fixture frozen, no network).
#
# Pemakaian: bootstrap-fixture.sh [repo-a|repo-b|repo-c|all]  (default: repo-a —
# dipakai smoke-omp/run-fase1 tanpa mengubah perilaku mereka).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

# Hapus semua worktree (kecuali worktree utama) + branch worker/* agar reset
# deterministik. Harus dipanggil sebelum `reset --hard` agar tidak ada worktree
# yang menghadang (stale detached worktree, conflict pada `worktree add` berikut).
cleanup_worktrees() {
  local FIX="$1"
  # hapus branch worker/* (jika masih ada setelah run sebelumnya)
  git -C "$FIX" branch --list 'worker/*' 2>/dev/null | sed 's/^[ *]*//' | while IFS= read -r br; do
    git -C "$FIX" branch -D "$br" 2>/dev/null || true
  done
  # hapus worktree tambahan (bukan worktree utama). `worktree prune` tidak selalu
  # menghapus direktori — pakai `remove --force` eksplisit.
  local main_root
  main_root="$(git -C "$FIX" rev-parse --show-toplevel 2>/dev/null || true)"
  git -C "$FIX" worktree list --porcelain 2>/dev/null \
    | awk '/^worktree /{print $2}' \
    | while IFS= read -r wt; do
        [ -z "$wt" ] && continue
        [ "$wt" = "$main_root" ] && continue
        git -C "$FIX" worktree remove --force "$wt" 2>/dev/null || true
      done
  git -C "$FIX" worktree prune 2>/dev/null || true
}

bootstrap_repo_a() {
  local FIX="$ROOT/tests/fixtures/repo-a"
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
    cleanup_worktrees "$FIX"
    if git -C "$FIX" rev-parse --verify -q buggy-initial >/dev/null; then
      git -C "$FIX" reset -q --hard buggy-initial
    else
      git -C "$FIX" reset -q --hard HEAD
    fi
    git -C "$FIX" clean -qfd
    echo "[bootstrap-fixture] repo-a di-reset ke buggy-initial (worktree/branch worker bersih)"
  fi
}

bootstrap_repo_b() {
  local FIX="$ROOT/tests/fixtures/repo-b"
  if [ ! -d "$FIX/.git" ]; then
    mkdir -p "$FIX/lib" "$FIX/tests"
    cat > "$FIX/lib/feature.py" <<'PY'
"""lib/feature.py — fixture repo-b (TASK-2.4). Fungsi `double` belum diimplementasi."""


def double(x: int) -> int:
    raise NotImplementedError
PY
    cat > "$FIX/tests/conftest.py" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
PY
    cat > "$FIX/tests/test_feature.py" <<'PY'
from lib.feature import double


def test_double_positive():
    assert double(21) == 42


def test_double_zero():
    assert double(0) == 0
PY
    printf '__pycache__/\n.pytest_cache/\n' > "$FIX/.gitignore"

    git -C "$FIX" init -q -b main
    git -C "$FIX" config user.name "Shorekeeper Fixture"
    git -C "$FIX" config user.email "fixture@shorekeeper.local"
    GIT_AUTHOR_DATE=2026-08-17T00:00:00Z GIT_COMMITTER_DATE=2026-08-17T00:00:00Z \
      git -C "$FIX" add -A
    GIT_AUTHOR_DATE=2026-08-17T00:00:00Z GIT_COMMITTER_DATE=2026-08-17T00:00:00Z \
      git -C "$FIX" commit -qm "fixture repo-b: double belum diimplementasi (pytest merah)"
    git -C "$FIX" tag buggy-initial
    echo "[bootstrap-fixture] repo-b dibuat (buggy-initial)"
  else
    cleanup_worktrees "$FIX"
    if git -C "$FIX" rev-parse --verify -q buggy-initial >/dev/null; then
      git -C "$FIX" reset -q --hard buggy-initial
    else
      git -C "$FIX" reset -q --hard HEAD
    fi
    git -C "$FIX" clean -qfd
    echo "[bootstrap-fixture] repo-b di-reset ke buggy-initial (worktree/branch worker bersih)"
  fi
}

bootstrap_repo_c() {
  local FIX="$ROOT/tests/fixtures/repo-c"
  if [ ! -d "$FIX/.git" ]; then
    mkdir -p "$FIX/lib" "$FIX/tests"
    cat > "$FIX/lib/greet.py" <<'PY'
"""lib/greet.py — fixture repo-c (TASK-2.4). Typo pada sapaan."""


def greet() -> str:
    return "Helllo, world"
PY
    cat > "$FIX/tests/conftest.py" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
PY
    cat > "$FIX/tests/test_greet.py" <<'PY'
from lib.greet import greet


def test_greet():
    assert greet() == "Hello, world"
PY
    printf '__pycache__/\n.pytest_cache/\n' > "$FIX/.gitignore"

    git -C "$FIX" init -q -b main
    git -C "$FIX" config user.name "Shorekeeper Fixture"
    git -C "$FIX" config user.email "fixture@shorekeeper.local"
    GIT_AUTHOR_DATE=2026-08-17T00:00:00Z GIT_COMMITTER_DATE=2026-08-17T00:00:00Z \
      git -C "$FIX" add -A
    GIT_AUTHOR_DATE=2026-08-17T00:00:00Z GIT_COMMITTER_DATE=2026-08-17T00:00:00Z \
      git -C "$FIX" commit -qm "fixture repo-c: typo Helllo (pytest merah)"
    git -C "$FIX" tag buggy-initial
    echo "[bootstrap-fixture] repo-c dibuat (buggy-initial)"
  else
    cleanup_worktrees "$FIX"
    if git -C "$FIX" rev-parse --verify -q buggy-initial >/dev/null; then
      git -C "$FIX" reset -q --hard buggy-initial
    else
      git -C "$FIX" reset -q --hard HEAD
    fi
    git -C "$FIX" clean -qfd
    echo "[bootstrap-fixture] repo-c di-reset ke buggy-initial (worktree/branch worker bersih)"
  fi
}

TARGET="${1:-repo-a}"
case "$TARGET" in
  repo-a) bootstrap_repo_a ;;
  repo-b) bootstrap_repo_b ;;
  repo-c) bootstrap_repo_c ;;
  all) bootstrap_repo_a; bootstrap_repo_b; bootstrap_repo_c ;;
  *) echo "[bootstrap-fixture] target tidak dikenal: $TARGET (pakai repo-a|repo-b|repo-c|all)"; exit 1 ;;
esac
