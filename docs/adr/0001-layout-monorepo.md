# ADR-001: Lokasi & layout monorepo shorekeeper

- **Status:** Accepted
- **Tanggal:** 2026-08-17
- **Deciders:** Orkestrator (Hermes) + user
- **Technical Story:** TASK-1.1 — fondasi monorepo FASE 1

## Context

Proyek Shorekeeper butuh satu repo yang memuat orchestrator (Hermes), front (LiveKit agent),
client UI, dan paket bersama (contract, bridge worker, task store). Saat ini kode tersebar di
dua repo sumber: `~/projects/jarvis-livekit` (agent Python + hermes_llm bridge) dan
`~/projects/shorekeeper-jarvis` (client Svelte 5 di `client/`; `server/` adalah pipeline G1
yang ditinggalkan permanen). Riset (`riset-project-structure-ai-agents.md`) merekomendasikan
monorepo pnpm + uv, bahasa campuran TS/Python.

Dua bahasa ⇒ dua toolchain: **pnpm workspaces** untuk TS (client + packages) dan **uv**
(standalone, bukan workspace) untuk Python — uv workspace lintas bahasa tidak diperlukan dan
membuat resolver kaku. Task store SQLite + zod contract dipakai bersama oleh orchestrator
(Hermes/Node) dan tooling TS, jadi keduanya TS-first.

## Decision

1. **Lokasi final monorepo: `~/projects/shorekeeper`** (sibling dari repo sumber). Path ini
   dikunci untuk seluruh fase; semua referensi path di TASKS.md/PRD mengarah ke sini.
2. **Layout (locked):**
   ```
   apps/agent/        Python (uv) — LiveKit agent G3
   apps/client/       Svelte 5 (dari shorekeeper-jarvis/client)
   packages/task-store/  SQLite WAL task store
   packages/contracts/   zod schema handoff + task record
   packages/omp-bridge/  bridge Hermes ↔ worker
   scripts/gates/     gate-fase1..3.sh
   scripts/e2e/       harness E2E
   tests/             fixtures/, unit/, behavioral/, e2e/, edge/
   docs/              PRD, ARCHITECTURE, API, TESTING, adr/, agents/, golden-set/
   AGENTS.md · TASKS.md · .env.example
   ```
3. **pnpm-workspace.yaml hanya berisi TS:** `apps/client` + `packages/*`. Python apps
   standalone via `pyproject.toml` masing-masing, dijalankan dengan `uv run --project apps/agent`.
4. **Migrasi minimal:** `apps/agent` hanya mengambil yang dipakai G3 (`src/agent.py`,
   `src/hermes_llm.py`, `src/__init__.py`, config + pyproject); `apps/client` = isi
   `client/` tanpa `node_modules`, `dist`, lockfile, dan `server/` G1 tidak dibawa.
5. **Tooling:** vitest (TS), pytest (Python), eslint + prettier (TS), ruff (Python);
   script `build/lint/test` per package dapat dijalankan `pnpm -r`.
6. Repo sumber TIDAK dimodifikasi dari monorepo (hanya dibaca).

## Consequences

- **Positif:** satu `pnpm -r build && lint && test` men-cover semua TS; uv menjaga isolasi
  Python (PEP 668) tanpa polusi workspace; boundary worker jelas lewat `tests/fixtures/`.
- **Negatif:** dua toolchain berarti dua cara install/pin deps; kontrak TS tidak bisa
  di-import langsung dari Python (orchestrator Hermes Node adalah pemakai utama; agent
  Python hanya membaca state via task store/file — bukan zod).
- **Risiko dikelola:** client yang ditinggalkan (server G1 Bun) tidak ikut ter-migrasi;
  migrasi dibatasi "yang dipakai G3" agar tidak membawa kode mati.
- **Verifikasi:** `git log` monorepo berisi initial commit; `git -C ~/projects/jarvis-livekit
  status --porcelain` kosong setelah TASK-1.1.