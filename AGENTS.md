# AGENTS.md — Shorekeeper monorepo

Hand-written governance file. Source of truth untuk konvensi kerja di repo ini.
Baca `README.md`, `docs/ARCHITECTURE.md`, `docs/PRD.md`, `docs/api.md` sebelum kerja.

## Stack

- **TS workspace (pnpm):** `apps/client` (Svelte 5 + Vite) + `packages/*` (contracts, omp-bridge, task-store — Node, ESM).
- **Python (uv, standalone — BUKAN workspace):** `apps/agent` (LiveKit agent). Per-app `pyproject.toml` + `uv run --project apps/agent ...`.
- SQLite WAL (better-sqlite3) untuk task store; zod untuk contract; vitest; eslint+prettier; ruff untuk Python.
- **Hard rule GRATIS:** dilarang dependency/API berbayar.

## Commands persis (dipakai quality gate)

```bash
pnpm install                      # install workspace
pnpm -r build                     # tsc build semua package + vite build client
pnpm -r lint                      # eslint semua package (warning = gagal)
pnpm -r test                      # vitest / node --test semua package
uv sync --project apps/agent      # sync deps Python
uv run --project apps/agent pytest -q apps/agent/tests  # scope eksplisit (fixture E2E di tests/fixtures sengaja merah)
uv run --project apps/agent ruff check .
bash -n scripts/gates/gate-fase1.sh
bash scripts/gates/gate-fase1.sh  # GATE FASE 1 (harus exit 0)
bash scripts/e2e/run-fase1.sh     # E2E fase 1
bash scripts/e2e/smoke-omp.sh     # smoke bridge worker
bash scripts/e2e/smoke-parallel.sh   # smoke worker manager (3 task paralel)
bash scripts/e2e/smoke-conflict.sh   # smoke conflict detection (2 task bentrok)
bash scripts/gates/gate-fase2.sh  # GATE FASE 2 (regresi F1 + E2E paralel, exit 0)
bash scripts/e2e/run-fase2.sh     # E2E fase 2 (skenario A/B/C)
bash scripts/eval/lint-golden.sh  # lint golden set (20 kasus, rubric lengkap)
bash scripts/eval/golden-run.sh   # golden suite ≥ 85% + 0 critical safety (ship bar)
bash scripts/otel/up.sh           # stack observability self-host (OTel+Jaeger+Prometheus)
bash scripts/otel/down.sh         # turunkan stack observability
bash scripts/e2e/smoke-prod.sh    # smoke instalasi "produksi" (service+trace Jaeger)
bash scripts/ops/backup-db.sh     # backup online task store SQLite
bash scripts/ops/restore-db.sh    # restore task store dari backup
bash scripts/gates/gate-fase3.sh  # GATE FASE 3 (regresi F1-2 + golden + smoke, exit 0)
```

## Layout

```
apps/agent/         Python (uv) — LiveKit agent G3 (src/agent.py, src/hermes_llm.py)
apps/client/        Svelte 5 client
packages/contracts/ zod schema handoff + task record
packages/omp-bridge/ bridge Hermes -> worker (mock/omp adapter, worktree, timeout, manager FASE-2)
packages/task-store/ SQLite WAL store + state machine + CLI
packages/conflict-map/ ownership map + pre-merge merge-tree check (FASE-2)
packages/merge-orchestrator/ merge gate tunggal: verifier + squash sequential + approval (FASE-2)
packages/observability/ OTel SDK setup + fail-open exporter + sanitize privasi (FASE-3)
scripts/gates/      gate-fase*.sh
scripts/e2e/        run-fase*.sh, smoke-omp.sh, smoke-parallel.sh, smoke-conflict.sh, smoke-prod.sh (+ logs/ git-ignored)
scripts/eval/       golden runner: lint-golden.sh, golden-run.sh (grade.mjs), test-corrupt.sh (FASE-3)
scripts/otel/       up.sh/down.sh stack observability self-host (FASE-3)
scripts/ops/        backup-db.sh / restore-db.sh task store (FASE-3)
deploy/             otel/ (collector+prometheus config), systemd/ (unit VPS) (FASE-3)
docs/               README-linked: PRD, ARCHITECTURE, api.md, adr/, agents/, runbooks/, observability.md,
                    EDGE-CASES.md, DEPLOYMENT.md, BLOCKERS.md, HANDOFF_DESIGN.md, golden-set/ (kasus YAML)
tests/              fixtures/, unit/, behavioral/, e2e/, edge/ (tests edge di packages/*/tests/edge)
data/               tasks.db + artifacts/ + ownership.json (git-ignored)
```

## Konvensi FASE 2 (merge gate & worker lifecycle)

- Orchestrator (`packages/merge-orchestrator`) = pemegang tunggal merge gate; worker
  TIDAK pernah push/commit ke main (hard prohibition). squash merge sequential;
  verifier merah → `blocked` + `error=VERIFY_FAILED`, tidak pernah force-merge.
- Push remote hanya dengan approval (`SHOREKEEPER_APPROVAL_GRANTED=1`); default
  `main-local` lokal saja. merge_commit (sha ≥ 7 char) di
  `data/artifacts/<task_id>/merge.json` + summary store (kontrak Fase 1 utuh).
- Worker manager (`packages/omp-bridge/src/manager.ts`): pool max 3 (hard cap),
  FIFO queue, heartbeat ≤ 30 s (single-writer), timeout → kill → retry idempoten
  (1s/4s/16s, hanya step idempoten), zombie → failed + alert (slot tidak terblokir),
  `recoverStale()` saat restart.
- Conflict detection (`packages/conflict-map`): one-file-one-owner,
  `data/ownership.json`; claimFiles/conflictsWith; pre-spawn check di manager;
  pre-merge `git merge-tree --name-only` di orchestrator; log
  `conflict-detected <a> <b> files=[...]` + counter ownership.json.
  Detection over resolution: false positive > false negative.

## Konvensi FASE 3 (production: observability, edge cases, golden, deploy)

- Observability (ADR-004): OTel SDK → OTLP → otel-collector → Jaeger +
  Prometheus, semua self-host (GRATIS). Span per task: root `task.run` →
  `delegate_task`, `worker.run`, `merge`; attributes METADATA SAJA —
  isi percakapan TIDAK PERNAH masuk trace (sanitize FORBIDDEN_ATTR_KEYS di
  packages/observability; gate meng-audit). Fail-open: kolektor mati →
  orkestrasi tetap jalan (warning log).
- Nama span & instrumen = kontrak versioned (snake_case): task_created_total,
  task_done_total, task_failed_total, task_retried_total,
  conflict_detected_total, worker_duration_seconds, merge_duration_seconds,
  worker_pool_size. Jangan ubah in-place tanpa bump (prinsip api.md).
- Golden set (docs/golden-set/gs-*.yaml, 20 kasus) = gerbang regresi & ship:
  ship bar LOCKED ≥85% success + 0 critical safety (jangan turunkan bar;
  audit rubrik bila gagal 2×). Kasus produksi gagal → tambah ke golden set
  (flywheel). Lint wajib sebelum run (rubric lengkap, distribusi kategori).
- Edge cases (docs/EDGE-CASES.md): state di store, bukan sesi; hasil terminal
  masuk outbox notify (delivered flag — dedupe); spec berisi path terlarang
  ditolak REPO_NOT_ALLOWED pre-spawn (spawn counter 0).
- Backup/restore task store: scripts/ops/backup-db.sh (online) +
  restore-db.sh; rollback = stop unit + restore DB satu file (uji restore
  sebelum traffic nyata).

## Konvensi kode — CORRECT vs WRONG

```ts
// CORRECT — task record dikirim via kontrak, divalidasi zod
const spec = HandoffSchema.parse(raw);          // throw dengan pesan field
// WRONG — menerima JSON mentah tanpa validasi
const spec = JSON.parse(raw);
```

```ts
// CORRECT — transisi state lewat task-store, error terstruktur
store.transition(taskId, "running");
// WRONG — update kolom status langsung di SQL (bypass state machine)
db.run("UPDATE tasks SET status='done' WHERE id=?", id);
```

```bash
# CORRECT — worker hanya dalam worktree fixture, tidak menyentuh repo lain
bash scripts/e2e/smoke-omp.sh
# WRONG — memanggil model berbayar / menyimpan key di kode
curl https://api.berbayar.example/v1 ...
```

- Commit: conventional commits (`feat(scope): …`, `fix(scope): …`, `chore: …`); branch per task, squash ke main.
- Status task: hanya `queued → running → done|failed|cancelled|blocked`; transisi invalid ditolak.
- Summary ≤ 200 kata (kontrak voice); artifact besar → filesystem `data/artifacts/<task_id>/`, DB hanya path.
- Single-writer store = orchestrator; worker lain tidak pernah menulis DB.
- Nama asisten = **Shorekeeper**. Dilarang nama agent lain di `docs/agents/` (grep -ri "jarvis" = kosong).
- Konvensi berubah → update file ini di commit yang sama (living document).

## Boundaries (jangan dilanggar)

- JANGAN sentuh `~/.hermes/` kecuali eksplisit di TASK (config hanya via `sed`, bukan write_file).
- JANGAN commit secrets / `.env` / API key.
- JANGAN tambah dependency berbayar; fixture E2E harus deterministik (no live model call wajib).
- Worker tidak pernah push/commit ke `main` — merge gate dipegang orchestrator (FASE 2).
- Repo sumber (`~/projects/jarvis-livekit`, `~/projects/shorekeeper-jarvis`) TIDAK boleh dimodifikasi dari monorepo.
- `~/.omp/agent/models.yml` hanya untuk konfigurasi model worker (sudah disiapkan).
- Jika blocked 2 percobaan → tulis `docs/BLOCKERS.md` + nyatakan BLOCKED, jangan menebak keputusan manusia.