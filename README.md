# Shorekeeper

Voice-first multi-agent AI assistant platform. Agen suara realtime (LiveKit + Gemini Live) menjadi antarmuka depan, Hermes berperan sebagai orchestrator, dan oh-my-pi (omp) sebagai coding workers — semuanya terkoordinasi lewat task store SQLite WAL dengan observability self-host (OpenTelemetry + Jaeger + Prometheus).

> Proyek privat. Hard rule: seluruh dependency & API **gratis** (nol langganan); LiveKit Cloud free tier dengan hard cap.

## Fitur Utama

- **Realtime voice agent** — LiveKit Agents SDK + Gemini Live API, penanganan interupsi, resumption sesi, notifikasi proaktif via outbox.
- **Multi-agent delegation** — spawn worker omp (atau mock worker untuk eksekusi cepat), paralelisme terkontrol, deteksi konflik task, retry.
- **Task store tahan crash** — SQLite WAL single-writer, atomic outbox, status task survive restart.
- **Observability end-to-end** — trace OTLP → Jaeger, metrics → Prometheus, stack naik/turun satu perintah.
- **Evaluasi berkualitas** — golden set YAML + rubric, quality gate shell exit-0 per fase.

## Arsitektur

```
                    ┌──────────────────────┐
   suara  ◄──────►  │  apps/client (Svelte) │ ◄──── browser user
                    └──────────┬───────────┘
                               │ WebRTC
                    ┌──────────▼───────────┐
                    │    LiveKit Cloud     │  (free tier, hard cap)
                    └──────────┬───────────┘
                               │
        ┌──────────────────────▼──────────────────────┐
        │        apps/agent (Python, LiveKit SDK)      │
        │  agent_gemini_live.py · hermes_llm.py        │
        └───────┬──────────────────────────┬──────────┘
                │ delegasi task            │ token JWT
        ┌───────▼────────┐         ┌───────▼──────────┐
        │ packages/      │         │ apps/token-server │
        │  omp-bridge    │         │ (aiohttp, :8082)  │
        │  → omp workers │         └──────────────────┘
        │  (atau MOCK)   │
        └───────┬────────┘
                │ tulis/baca
        ┌───────▼──────────────────────────┐
        │ packages/task-store (SQLite WAL) │◄─── orchestrator (Hermes WS)
        └──────────────────────────────────┘

        ┌──────────────────────────────────┐
        │ Observability: OTel Collector →  │  Jaeger (:16686, base-path /jaeger)
        │ traces + Prometheus metrics      │  Prometheus (:9090)
        └──────────────────────────────────┘  semua bind 127.0.0.1
```

Alur ringkas: user berbicara ke client → media mengalir via LiveKit Cloud ke `apps/agent` → agen memproses dengan Gemini Live; task kerja didelegasikan lewat `omp-bridge` ke worker oh-my-pi (produksi memakai mock worker agar eksekusi cepat dan bebas dependensi Hermes), hasilnya tertulis di task store; orchestrator Hermes mengambil/memasukkan task lewat WS. Semua komponen produksi bind `127.0.0.1` — akses publik hanya via Nginx/domain.

## Stack

| Lapisan | Teknologi |
|---|---|
| Voice agent | Python 3.10+, LiveKit Agents SDK, Gemini Live API (`uv` per-app, bukan workspace) |
| Client | Svelte 5 + Vite + TypeScript |
| Packages | Node ESM (pnpm workspaces), better-sqlite3 (SQLite WAL), zod |
| Token server | Python aiohttp (LiveKit JWT) |
| Observability | OpenTelemetry Collector, Jaeger all-in-one, Prometheus (Docker Compose) |
| Quality | vitest, eslint + prettier, ruff, pytest, quality gate exit-0 |

## Struktur Repo

```
apps/
  agent/          # LiveKit voice agent (Python): Gemini Live, LLM bridge, notifikasi
  client/         # Svelte 5 UI: voice orb, recorder, pemilih model/voice
  token-server/   # LiveKit JWT endpoint (aiohttp)
packages/
  contracts/      # handoff-contract JSON/zod — source of truth skema lintas komponen
  omp-bridge/     # integrasi oh-my-pi: spawn worker, mock worker, timeout, error mapping
  task-store/     # SQLite WAL: status task, atomic outbox, single-writer
  conflict-map/   # deteksi task bentrok
  merge-orchestrator/ # penggabungan hasil multi-worker
  observability/  # helper tracing/metrics OTel
scripts/
  gates/          # quality gate per fase (exit-0 = lolos)
  e2e/            # harness E2E + smoke (parallel, conflict, prod)
  eval/           # golden set runner + linter
  otel/           # naik/turun stack observability
  ops/            # backup/restore DB online
tests/
  unit/ integration/ e2e/   # fixtures nested-repo di-bootstrap deterministik
docs/
  adr/            # decision records (layout, transport omp, merge policy, observability)
  agents/         # persona prompt: SOUL, FRONT_AGENT, VOICE_MODE, dll.
  golden-set/     # kasus uji emas (YAML)
  runbooks/
```

## Menjalankan

Prasyarat: Node.js ≥ 22, pnpm ≥ 9, `uv` + Python ≥ 3.10, Docker + Compose v2 (untuk observability).

```bash
# workspace TS
pnpm install
pnpm -r build
pnpm -r lint          # warning = gagal
pnpm -r test

# agent Python
uv sync --project apps/agent
uv run --project apps/agent pytest -q apps/agent/tests
uv run --project apps/agent ruff check .

# observability stack (bind localhost)
bash scripts/otel/up.sh
bash scripts/otel/down.sh

# smoke & gate
bash scripts/e2e/smoke-omp.sh        # delegasi satu task (mock worker)
bash scripts/e2e/smoke-parallel.sh   # 3 task paralel
bash scripts/gates/gate-fase1.sh     # GATE FASE 1 (exit 0)
```

Detail deployment ke VPS (budget RAM ketat 3,6 GB, systemd, port): lihat [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Konfigurasi

Salin `.env.example` → `.env.local` (di-root `apps/agent/`) dan isi kredensial LiveKit/Gemini. File `.env*` tidak pernah masuk git. Mode produksi daemon memakai mock worker (`OMP_BRIDGE_MOCK=1`) secara default.

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design & diagram C4 |
| [docs/PRD.md](docs/PRD.md) | Product requirements |
| [docs/api.md](docs/api.md) | Kontrak API & skema handoff |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Panduan deploy WSL → VPS |
| [docs/BLOCKERS.md](docs/BLOCKERS.md) | Bloker teknis terbuka (OMP-001, dll.) |
| [docs/HANDOFF_DESIGN.md](docs/HANDOFF_DESIGN.md) | Desain serah-terima multi-device |
| [docs/EDGE-CASES.md](docs/EDGE-CASES.md) | Katalog edge case (E01–E33) |
| [docs/observability.md](docs/observability.md) | Tracing & metrics |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [AGENTS.md](AGENTS.md) | Konvensi kerja & perintah quality gate |

## Kredit

Dibangun oleh [Schnee111](https://github.com/Schnee111).
