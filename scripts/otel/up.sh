#!/usr/bin/env bash
# scripts/otel/up.sh — naikkan stack observability self-host (TASK-3.1 requirement 3).
#
# Perilaku error case yang di-enforce:
# - docker tidak ada        → pesan jelas + exit 1 (jangan silent).
# - port sudah dipakai      → LAPOR port & proses pemakai, exit 1 (jangan paksa bind).
# - naik                    → docker compose up -d + healthcheck (prometheus, jaeger).
#
# Dipanggil manual / gate-fase3.sh (via smoke-prod). Idempotent.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORTS=(4318 16686 9090 4317 13133)

log() { echo "[otel-up] $*"; }
err() { echo "[otel-up][ERROR] $*" >&2; }

# --- prasyarat: docker -------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  err "docker tidak terinstall — pasang Docker Engine dulu (lihat docs/DEPLOYMENT.md)"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  err "docker daemon tidak berjalan — jalankan 'sudo systemctl start docker' atau 'service docker start'"
  exit 1
fi

# --- deteksi port bentrok SEBELUM bind (jangan paksa) ------------------------
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$" && return 0
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  # fallback: /dev/tcp probe (hanya deteksi, tidak bind)
  (echo > "/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1 && return 0
  return 1
}

describe_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E "[:.]${port} " | head -1 || echo "(proses tidak terdeteksi — butuh root untuk detail)"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +1 || true
  fi
}

CONFLICT=0
for p in "${PORTS[@]}"; do
  if port_in_use "$p"; then
    # Port yang SUDAH dipakai oleh stack kita sendiri (compose up sebelumnya) tidak masalah.
    if docker compose -f docker-compose.otel.yaml ps --status running 2>/dev/null | grep -q .; then
      # sudah ada container kita yang jalan → anggap idempotent (re-up aman)
      continue
    fi
    err "port ${p} sudah dipakai proses lain:"
    describe_port "$p" | sed 's/^/    /' >&2 || true
    CONFLICT=1
  fi
done
if [ "$CONFLICT" = "1" ]; then
  err "hentikan proses di port di atas dulu, atau jalankan 'bash scripts/otel/down.sh' bila itu stack lama."
  err "TIDAK memaksa bind (fail-safe)."
  exit 1
fi

# --- naikkan stack -----------------------------------------------------------
# File konfigurasi dibaca container non-root → wajib world-readable (isi bukan secret).
chmod a+r deploy/otel/otel-collector-config.yaml deploy/otel/prometheus.yaml 2>/dev/null || true
log "docker compose up -d (image akan di-pull bila belum ada)"
docker compose -f docker-compose.otel.yaml up -d

# --- healthcheck (retry singkat) --------------------------------------------
wait_http() {
  local url="$1" name="$2" tries="${3:-30}"
  for i in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "${name} sehat: ${url}"
      return 0
    fi
    sleep 1
  done
  err "${name} tidak sehat setelah ${tries}s: ${url}"
  return 1
}

wait_http "http://localhost:9090/-/healthy" "prometheus" 40
wait_http "http://localhost:13133/" "otel-collector(health_check)" 40
# Jaeger readiness: UI/API /api/services mengembalikan 200 (walau daftar kosong)
for i in $(seq 1 40); do
  if curl -sf "http://localhost:16686/api/services" >/dev/null 2>&1; then
    log "jaeger sehat: http://localhost:16686"
    break
  fi
  if [ "$i" = "40" ]; then err "jaeger tidak sehat setelah 40s"; exit 1; fi
  sleep 1
done

log "stack observability NAIK. Endpoint aplikasi: OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318"
log "trace UI  : http://localhost:16686 (service=shorekeeper-orchestrator)"
log "metrics   : http://localhost:9090 (query: task_done_total dst.)"
