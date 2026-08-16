# AGENTS.md — Shorekeeper monorepo

Hand-written governance file (TASK-1.1). Source of truth untuk konvensi kerja di repo ini.
Baca `TASKS.md` (plan), `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/api.md` sebelum kerja.

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
uv run --project apps/agent pytest -q
uv run --project apps/agent ruff check .
bash -n scripts/gates/gate-fase1.sh
bash scripts/gates/gate-fase1.sh  # GATE FASE 1 (harus exit 0)
bash scripts/e2e/run-fase1.sh     # E2E fase 1
bash scripts/e2e/smoke-omp.sh     # smoke bridge worker
```

## Layout

```
apps/agent/         Python (uv) — LiveKit agent G3 (src/agent.py, src/hermes_llm.py)
apps/client/        Svelte 5 client
packages/contracts/ zod schema handoff + task record
packages/omp-bridge/ bridge Hermes -> worker (mock/omp adapter, worktree, timeout)
packages/task-store/ SQLite WAL store + state machine + CLI
scripts/gates/      gate-fase*.sh
scripts/e2e/        run-fase1.sh, smoke-omp.sh (+ logs/ git-ignored)
docs/               PRD, ARCHITECTURE, api.md, adr/, agents/, runbooks/
tests/              fixtures/, unit/, behavioral/, e2e/, edge/
data/               tasks.db + artifacts/  (git-ignored)
```

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

- Commit: `TASK-x.y: <ringkas>` per task; branch per task, squash ke main.
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