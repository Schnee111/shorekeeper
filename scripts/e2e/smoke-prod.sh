#!/usr/bin/env bash
# scripts/e2e/smoke-prod.sh — smoke test instalasi "produksi" (TASK-3.4 req 3).
#
# Dirancang untuk staging (WSL lokal) maupun VPS: memverifikasi stack OTel
# hidup, menjalankan 1 task E2E singkat di fixture dengan OTel aktif, lalu
# memverifikasi store (1 task done) + trace id muncul di Jaeger.
#
# Error case: service down → exit non-0 + print status ringkas
# (`docker compose ps` / `systemctl status` bila systemd unit ada).
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { echo "[smoke-prod][$(date +%H:%M:%S)] $*"; }
fail() { log "FAIL: $*"; status_ringkas; exit 1; }

status_ringkas() {
  log "--- status ringkas ---"
  if [ -f /etc/systemd/system/shorekeeper-orchestrator.service ] && command -v systemctl >/dev/null 2>&1; then
    systemctl status shorekeeper-orchestrator shorekeeper-agent shorekeeper-otel --no-pager -n 5 2>&1 | head -40 || true
  fi
  if command -v docker >/dev/null 2>&1; then
    docker compose -f docker-compose.otel.yaml ps -a 2>&1 | head -10 || true
  fi
  log "----------------------"
}

# --- 1. OTel stack (kolektor + Jaeger + Prometheus) harus hidup --------------
if ! command -v docker >/dev/null 2>&1; then
  fail "docker tidak ada — stack observability tidak bisa di-smoke (lihat docs/DEPLOYMENT.md)"
fi
if ! docker compose -f docker-compose.otel.yaml ps --status running 2>/dev/null | grep -q otel-collector; then
  log "stack OTel belum naik — coba naikkan dulu"
  bash scripts/otel/up.sh || fail "scripts/otel/up.sh gagal"
fi

curl -sf "http://localhost:9090/-/healthy" >/dev/null || fail "prometheus tidak sehat (9090)"
curl -sf "http://localhost:13133/" >/dev/null || fail "otel-collector health_check tidak sehat (13133)"
curl -sf "http://localhost:16686/api/services" >/dev/null || fail "jaeger tidak sehat (16686)"
log "service sehat: collector, jaeger(16686), prometheus(9090)"

# --- 2. Jalankan 1 task E2E singkat dengan OTel aktif ------------------------
DB="data/tasks-smoke-prod.db"
rm -f "$DB" "$DB-wal" "$DB-shm"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"
export OMP_BRIDGE_MOCK=1
export OMP_BRIDGE_ALLOWLIST="$PWD/tests/fixtures/repo-a"
export SHOREKEEPER_VERIFY_CMD="uv run --project $PWD/apps/agent python -m pytest -q tests -p no:cacheprovider"

bash scripts/e2e/bootstrap-fixture.sh >/dev/null
E2E_DB="$PWD/$DB" bash scripts/e2e/run-fase1.sh || fail "E2E 1 task gagal (run-fase1.sh exit non-0)"
log "E2E 1 task selesai"

# --- 3. Verifikasi store: 1 task done ----------------------------------------
STATUS="$(node packages/task-store/dist/cli.js --db "$DB" status task_e2e_01)"
echo "$STATUS" | grep -q '"done"' || fail "store: task_e2e_01 tidak done — $STATUS"
log "store OK: task_e2e_01 done (1 task)"

# --- 4. Verifikasi trace id muncul di Jaeger ---------------------------------
TRACE_ID="$(grep -h "otel trace_id=" scripts/e2e/logs/run-fase1-*.log 2>/dev/null | tail -1 | sed -E 's/.*trace_id=([0-9a-f]+).*/\1/')"
[ -n "${TRACE_ID:-}" ] || fail "trace id tidak ditemukan di log run-fase1"
log "trace_id=$TRACE_ID"

sleep 2 # beri waktu collector → jaeger
JA="scripts/e2e/logs/smoke-prod-jaeger.json"
curl -s "http://localhost:16686/api/traces/${TRACE_ID}" -o "$JA" || fail "Jaeger API tidak menjawab"
grep -q "\"traceID\":\"${TRACE_ID}\"" "$JA" || fail "trace $TRACE_ID tidak ditemukan di Jaeger"
for OP in task.run delegate_task worker.run merge; do
  grep -q "\"operationName\":\"${OP}\"" "$JA" || fail "span ${OP} tidak ada di trace $TRACE_ID"
done
log "trace diverifikasi di Jaeger: task.run → delegate_task → worker.run → merge"
rm -f "$JA"

# --- 5. Metric dasar ada di Prometheus ---------------------------------------
curl -s "http://localhost:9090/api/v1/query?query=task_done_total" | grep -q "task_done_total" \
  || fail "metric task_done_total tidak ada di Prometheus"
log "metric task_done_total ter-query di Prometheus"

log "SMOKE-PROD: PASS"
