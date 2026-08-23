#!/usr/bin/env bash
# scripts/ops/backup-db.sh — backup ONLINE task store SQLite (TASK-3.4 req 4).
#
# Pakai better-sqlite3 `db.backup()` (konsisten walau WAL + penulis aktif;
# RPO ≈ interval backup). Simpan: data/backups/tasks-<ts>.db + keep N terbaru
# (default 14). Error case: DB tidak ada / integrity gagal → exit non-0.
#
# Env: TASKS_DB (default data/tasks.db), BACKUP_KEEP (default 14),
#      BACKUP_DIR (default data/backups).
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="${TASKS_DB:-data/tasks.db}"
DIR="${BACKUP_DIR:-data/backups}"
KEEP="${BACKUP_KEEP:-14}"
TS="$(date +%Y%m%d-%H%M%S)"
DEST="$DIR/tasks-$TS.db"

log() { echo "[backup-db] $*"; }

if [ ! -f "$DB" ]; then
  log "ERROR: DB $DB tidak ada"
  exit 1
fi

mkdir -p "$DIR"
# Backup online via CLI task-store (dist sudah di-build gate; build bila belum).
[ -f packages/task-store/dist/cli.js ] || pnpm --filter task-store build >/dev/null
node packages/task-store/dist/cli.js --db "$DB" backup "$DEST" >/dev/null

# better-sqlite3 di-resolve dari package task-store (pnpm tidak hoist ke root).
NODE_PATH="$PWD/packages/task-store/node_modules:$PWD/node_modules"
export NODE_PATH

# Verifikasi hasil backup: PRAGMA integrity_check = ok (rollback-proof).
CHK="$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true });
console.log(db.pragma('integrity_check', { simple: true }));
db.close();
" "$DEST")"
if [ "$CHK" != "ok" ]; then
  log "ERROR: backup $DEST gagal integrity_check ($CHK)"
  rm -f "$DEST"
  exit 1
fi

# Rotasi: simpan KEEP terbaru (urut nama = urut waktu karena prefix timestamp).
cd "$DIR"
ls -1 tasks-*.db 2>/dev/null | sort | head -n -"$KEEP" | while IFS= read -r f; do
  rm -f "$f"
done
cd - >/dev/null

log "backup OK: $DEST (integrity=ok, keep=$KEEP)"
