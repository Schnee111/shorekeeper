# ADR-004: Stack observability — OTel + Jaeger + Prometheus self-host

- **Status:** accepted
- **Tanggal:** 2026-08-17
- **Task:** TASK-3.1 (FASE 3 PRODUCTION)
- **Supersedes:** —

## Konteks

FASE 3 membutuhkan observability produksi: trace per task
(handoff → worker → merge), metrics (success/retry/durasi/konflik/pool), dan
backend yang bisa di-query. Hard rule: **GRATIS, nol langganan** — semua
komponen wajib self-host.

Kandidat (riset `/mnt/d/riset-observability-eval-voice-agent.md` + evaluasi):

| Opsi | Plus | Minus |
|---|---|---|
| **OTel SDK → OTel Collector → Jaeger + Prometheus** | standar industri, vendor-neutral, free, self-host docker compose sederhana, satu protokol (OTLP) untuk trace+metric | setup collector config |
| Langfuse self-host | UI eval LLM bagus | fokus LLM-eval (fase voice), lebih berat (Postgres + web), belum dibutuhkan fase ini |
| Jaeger langsung (tanpa collector) | lebih sedikit container | tidak ada metrics; Prometheus tetap perlu jalur sendiri |

## Keputusan

**OpenTelemetry SDK (TS) → OTLP/HTTP → otel/opentelemetry-collector-contrib →
Jaeger (trace) + Prometheus (metrics), semua self-host via docker compose.**

- Trace backend: `quay.io/jaegertracing/all-in-one:1.62.0` (UI/API :16686,
  storage in-memory — cukup dev/staging; untuk produksi VPS tambah volume/badger).
- Metrics: `prom/prometheus:v2.53.3` (:9090) scrape prometheus-exporter
  collector (:8889).
- Collector: `otel/opentelemetry-collector-contrib:0.117.0`, receiver OTLP/HTTP
  :4318, pipelines traces→otlp/jaeger dan metrics→prometheus.
- Langfuse: **ditolak untuk sekarang** (opsional, revisit fase voice bila perlu
  eval LLM-judge berbasis UI — keputusan baru = ADR baru).
- Grafana dashboard penuh & alerting: out of scope (TASK-3.1), UI Jaeger +
  Prometheus query cukup.

## Konsekuensi

1. **Privasi (hard rule):** trace hanya memuat METADATA (task_id, lane, status,
   worker_pid, retry_count, durasi). Isi percakapan TIDAK PERNAH masuk span —
   di-enforce `sanitizeAttrs()` (buang key `transcript`/`user_said`) di
   `packages/observability` + grep gate di `gate-fase3.sh`.
2. **Fail-open:** kolektor mati → eksportir wrapper (`FailOpenTraceExporter`/
   `FailOpenMetricExporter`) menelan kegagalan + warning; orkestrasi tetap
   jalan & exit 0. Ini assertion wajib (test unit + E2E endpoint mati).
3. **Nama instrumen = kontrak** (versioned, snake_case): counter
   `task_created_total`, `task_done_total`, `task_failed_total`,
   `task_retried_total`, `conflict_detected_total`; histogram
   `worker_duration_seconds`, `merge_duration_seconds`; gauge
   `worker_pool_size`. Span: root `task.run` → `delegate_task`, `worker.run`,
   `merge`.
4. **Resource VPS (3.6 GB RAM):** stack OTel ±250–350 MB total; muat, tapi
   jalankan bersama komponen lain sesuai tabel DEPLOYMENT.md; retention
   Prometheus dibatasi 2 hari (compose) agar disk 14 GB tidak jebol.
5. Endpoint aplikasi: env `OTEL_EXPORTER_OTLP_ENDPOINT`
   (default `http://localhost:4318`).

## Referensi

- `docker-compose.otel.yaml`, `deploy/otel/otel-collector-config.yaml`,
  `deploy/otel/prometheus.yaml`
- `scripts/otel/up.sh` / `scripts/otel/down.sh` (deteksi port bentrok + healthcheck)
- `packages/observability/` (SDK setup, fail-open exporter, sanitize privasi)
- `docs/observability.md` (cara query trace & metric)
