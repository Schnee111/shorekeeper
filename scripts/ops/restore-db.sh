#!/usr/bin/env bash
# scripts/ops/restore-db.sh — restore task store dari backup (TASK-3.4).
#
# Bagian dari prosedur rollback: stop unit orchestrator → restore → start lagi.
# Langkah: verifikasi backup (integrity_check) → ganti DB lama (disimpan sebagai
# .pre-restore) → salin backup → integrity_check DB hidup → laporan.
#
# Pemakaian: scripts/ops/restore-db.sh [PATH_BACKUP]
#   default: backup terbaru di data/backups/.
# Error case: backup tidak ada / integrity gagal → exit non-0 TANPA menyentuh DB.
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="${TASKS_DB:-data/tasks.db}"
DIR="${BACKUP_DIR:-data/backups}"

log() { echo "[restore-db] $*"; }

# better-sqlite3 di-resolve dari package task-store (pnpm tidak hoist ke root).
NODE_PATH="$PWD/packages/task-store/node_modules:$PWD/node_modules"
export NODE_PATH

BACKUP="${1:-}"
if [ -z "$BACKUP" ]; then
  BACKUP="$(ls -1 "$DIR"/tasks-*.db 2>/dev/null | sort | tail -1 || true)"
fi
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
  log "ERROR: backup tidak ditemukan (argumen path atau isi $DIR)"
  exit 1
fi

# 1. Verifikasi backup SEBELUM menyentuh DB hidup.
CHK="$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true });
console.log(db.pragma('integrity_check', { simple: true }));
db.close();
" "$BACKUP")"
if [ "$CHK" != "ok" ]; then
  log "ERROR: backup $BACKUP rusak (integrity=$CHK) — TIDAK di-restore"
  exit 1
fi
log "backup $BACKUP sehat (integrity=ok)"

# 2. Amankan DB hidup (untuk forensik bila restore keliru).
if [ -f "$DB" ]; then
  cp -f "$DB" "$DB.pre-restore"
fi

# 3. Restore: ganti DB + buang WAL/SHM lama.
rm -f "$DB-wal" "$DB-shm"
cp -f "$BACKUP" "$DB"

# 4. Verifikasi DB hidup pasca-restore.
CHK2="$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true });
console.log(db.pragma('integrity_check', { simple: true }));
db.close();
" "$DB")"
if [ "$CHK2" != "ok" ]; then
  log "ERROR: DB hidup gagal integrity pasca-restore — kembalikan $DB.pre-restore"
  cp -f "$DB.pre-restore" "$DB"
  exit 1
fi

N="$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true });
console.log(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n);
db.close();
" "$DB")"
log "restore OK: $DB (integrity=ok, tasks=$N). DB lama di $DB.pre-restore"
log "selanjutnya: start ulang unit orchestrator (lihat docs/DEPLOYMENT.md §Rollback)"
