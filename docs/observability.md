# Observability — Shorekeeper (TASK-3.1)

Stack: **OTel SDK → OTLP/HTTP → otel-collector → Jaeger (trace) + Prometheus
(metrics)**, semua self-host (lihat `docs/adr/0004-observability.md`).
Service name: **`shorekeeper-orchestrator`**.

**Privasi (hard rule):** trace/metric hanya METADATA (`task_id`, `lane`,
`status`, `worker_pid`, `retry_count`, durasi). Isi percakapan TIDAK PERNAH
masuk trace — di-enforce `sanitizeAttrs()` + grep gate (`gate-fase3.sh`).

## Naik/turun stack

```bash
bash scripts/otel/up.sh     # deteksi port bentrok → docker compose up -d → healthcheck
bash scripts/otel/down.sh   # turunkan stack
```

Port: `4318` (OTLP/HTTP masuk), `16686` (Jaeger UI/API), `9090` (Prometheus),
`4317` (OTLP gRPC internal), `13133` (collector health).

Aplikasi membaca env `OTEL_EXPORTER_OTLP_ENDPOINT` (default
`http://localhost:4318`). Kolektor mati → orkestrasi TETAP jalan (fail-open,
warning di log) — dibuktikan test + E2E.

## Hirarki span per task (kontrak nama — versioned)

```
task.run            (root: satu per task; attrs task_id, lane, status, retry_count)
├── delegate_task   (enqueue→ack; attrs attempt, spawn_seq, delegate_ms)
├── worker.run      (durasi worker; attrs attempt, exit_code, worker_pid)
└── merge           (merge gate; attrs merge_status, merge_commit)
```

Error → span status `ERROR` + attribute `error.code` (mis. `TIMEOUT`,
`VERIFY_FAILED`, `REPO_NOT_ALLOWED`).

## Query trace (Jaeger API)

```bash
# service terdaftar
curl -s "http://localhost:16686/api/services"

# semua trace orkestrator (1 task = 1 trace id)
curl -s "http://localhost:16686/api/traces?service=shorekeeper-orchestrator&limit=10"

# detail 1 trace (ganti <traceID>) → lihat span list task.run→delegate_task→worker.run→merge
curl -s "http://localhost:16686/api/traces/<traceID>"

# latensi delegate_task: buka UI http://localhost:16686 → Service
# shorekeeper-orchestrator → Operation delegate_task → duration per span
# (atau parse field duration (µs) dari JSON API di atas).
```

Contoh log E2E yang memuat trace id (baris `otel trace_id=...`):

```bash
grep "otel trace_id" scripts/e2e/logs/run-fase1-*.log | tail -1
```

## Query metrics (Prometheus)

Nama instrumen (kontrak TASK-3.1 — jangan ubah tanpa bump):

| Metric | Tipe | Keterangan |
|---|---|---|
| `task_created_total` | counter | task dibuat |
| `task_done_total` | counter | task selesai sukses |
| `task_failed_total` | counter | task gagal |
| `task_retried_total` | counter | retry attempt worker |
| `conflict_detected_total` | counter | deteksi konflik (TASK-2.3) |
| `worker_duration_seconds` | histogram | durasi worker per attempt |
| `merge_duration_seconds` | histogram | durasi merge gate per task |
| `worker_pool_size` | gauge | slot pool terpakai |

```bash
# nilai counter setelah E2E (harus ≥ 1)
curl -s "http://localhost:9090/api/v1/query?query=task_done_total"

# laju kegagalan 5 menit terakhir
curl -s "http://localhost:9090/api/v1/query" \
  --data-urlencode 'query=rate(task_failed_total[5m])'

# p95 durasi worker
curl -s "http://localhost:9090/api/v1/query" \
  --data-urlencode 'query=histogram_quantile(0.95, rate(worker_duration_seconds_bucket[10m]))'
```

## Catatan fase voice (belum diinstrumentasi)

- Instrumentasi pipeline LiveKit = fase voice; field `llm_node_ttft` /
  `tts_node_ttfb` KOSONG untuk realtime model (riset) — jangan diandalkan.
