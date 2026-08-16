# ADR-002: Transport omp — RPC stdio vs Node SDK + keputusan mock worker (FASE-1)

- **Status:** Accepted
- **Tanggal:** 2026-08-17
- **Deciders:** Orkestrator (Hermes) + user
- **Technical Story:** TASK-1.3 — POC bridge Hermes ↔ oh-my-pi (omp)

## Context

Hermes (orchestrator) perlu mendelegasikan satu task coding ke worker oh-my-pi dan
menerima hasil terverifikasi. Dua kandidat transport:

1. **Node SDK `createAgentSession`** — API programatik resmi omp. Menarik, tapi SDK
   menarik dependency besar (agent runtime, livekit, dst) ke bridge, dan mengikat
   bridge ke versi SDK tertentu; tidak sesuai konstrain RAM VPS 3.6GB (omp on-demand,
   bukan daemon).
2. **RPC stdio `omp --mode rpc`** — CLI sudah ter-install global
   (`~/.hermes/node/lib/node_modules/oh-my-pi/bin/oh-my-pi.js`), transport minimal:
   spawn proses per task, kirim task spec JSON via stdin, baca hasil via stdout;
   side effect = spawn (reversible: kill saat timeout), approval = no (docs/api.md §3.1).

### Temuan verifikasi (2026-08-17): bin omp RUSAK — OMP-001

Percobaan `node bin/oh-my-pi.js version` gagal dengan dua cacat packaging:

1. `bin/oh-my-pi.js` meng-import `../src/shared/jsonc-parser.ts` dan
   `../src/config/schema.ts` — direktori `src/` TIDAK ikut di-pack (hanya `dist/`
   yang ada di package). Module tidak ditemukan.
2. Bahkan file bin itu sendiri berisi anotasi TypeScript
   (`function checkFile(path: string, label: string)`) di file `.js` — Node
   melempar `SyntaxError: Unexpected token ':'` sebelum sempat mengeksekusi.

`node --experimental-strip-types` tidak membantu (type-stripping hanya untuk
file `.ts`, bukan `.js` dengan anotasi TS). CLI `omp` juga tidak ada di PATH
(tidak ada symlink di `~/.hermes/node/bin`). Full repro di `docs/BLOCKERS.md` (OMP-001).

## Decision

1. **Transport nyata (post blocker): RPC stdio `omp --mode rpc`** — dipilih karena
   minimal, on-demand per task, dan kontrak data lewat JSON di stdin/stdout (bukan
   ikatan SDK). Bridge menspawn `omp --mode rpc` dengan cwd = worktree git terisolasi
   dan task spec (TASK-1.2) via stdin. Keputusan ini berlaku jika omp sudah diperbaiki
   (reinstall dari source / upstream fix — lihat BLOCKERS).
2. **FASE-1: worker MOCK deterministik** (`OMP_BRIDGE_MOCK=1`) — bin omp tidak dapat
   dipakai (OMP-001). Untuk memenuhi acceptance TASK-1.3/1.5 (fixture frozen,
   no live model call WAJIB), bridge berjalan dengan mock worker
   (`src/mock-worker.ts`): script deterministik yang menerapkan fix fixture
   (`lib/math.py`: `return a - b` → `return a + b`) lalu menjalankan
   `verification_steps` dari task spec. Semua test & E2E FASE-1 memakai mode ini;
   `~/.omp/agent/models.yml` tetap dipertahankan (routing 9router free
   `opencode/deepseek-v4-flash-free` via `custom:aeter`) dan menjadi satu-satunya
   langkah yang tersisa untuk membuka mode nyata.
3. **Allowlist repo** (default deny): `runTask` menolak repo di luar allowlist dengan
   `REPO_NOT_ALLOWED` TANPA spawn. Allowlist dari `opts.allowlist` atau env
   `OMP_BRIDGE_ALLOWLIST` (":"-separated, real path). Scripts E2E mengekspor
   `OMP_BRIDGE_ALLOWLIST=<repo fixture>` eksplisit.
4. **Worktree isolation**: worker selalu berjalan di `git worktree add --detach`
   (bukan checkout branch); perubahan worker tidak pernah menyentuh repo utama.
   Orchestrator yang memutuskan merge (FASE-2: merge gate).
5. Tool Hermes `omp_spawn_worker(task_spec, repo_path, timeout_seconds)` mengikuti
   docs/api.md §3.1; demo satu-perintah = `bash scripts/e2e/smoke-omp.sh`.

## Consequences

- **Positif:** E2E FASE-1 deterministik & offline (mock worker); bridge tetap
  menyiapkan transport nyata (spawn `omp --mode rpc`) sehingga unblock tinggal
  memperbaiki OMP-001; isolasi worktree mencegah worker merusak repo utama;
  allowlist default-deny menutup path repo arbitrer tanpa persetujuan.
- **Negatif:** worker mock TIDAK menguji kemampuan coding model — validasi POC
  terbatas pada kontrak transport (spec → diff → verifikasi), bukan kualitas hasil
  model. Risk accepted untuk FASE-1; FASE-2 wajib unblock OMP-001 sebelum E2E paralel.
- **Risiko dikelola:** `~/.omp/agent/models.yml` tidak berubah; jika omp diperbaiki,
  cukup hapus env `OMP_BRIDGE_MOCK` (tanpa perubahan kode bridge).
- **Verifikasi:** `bash scripts/e2e/smoke-omp.sh` exit 0 (mock); unit test bridge
  membuktikan TIMEOUT < 305s, REPO_NOT_ALLOWED tanpa spawn (counter = 0),
  worktree isolation.