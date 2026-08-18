# SPRINT-VOICE-PRODUCTION.md — Front Agent Waras + Jalur Task Nyata

**Status dokumen:** Final v1 · **Tanggal:** 2026-08-18 · **Eksekusi:** satu `/goal` otonom (user pergi)
**Pembaca:** Agent `/goal` + reviewer manusia · **Bahasa kerja:** Indonesia
**Sumber riset:** `docs/RISET-FRONT-AGENT-REDESIGN.md`, `docs/HANDOFF_DESIGN.md`

> Tujuan: front agent Gemini Live yang proaktif, sadar konteks, tahan sesi panjang,
> dan jalur delegasi task yang benar-benar dieksekusi worker omp nyata (bukan mock/dummy).
> TANPA fallback model chain, TANPA multi-device, TANPA over-engineering.

---

## 0. Cara Pakai & Aturan Main

1. **Satu goal besar**, dijalankan sekuensial per sprint (A→B→C→D→E). Setiap sprint punya
   acceptance criteria command-based. Tandai `[x]` di file ini + commit per task selesai.
2. **Commit per perubahan diskrit**: `SPRINT-X.y: <ringkas>`. Jangan squash lintas sprint.
3. **Verifikasi diri sebelum tandai `[x]`**: jalankan command acceptance; bukti = output command
   di pesan terakhir (judge hanya baca pesan terakhir).
4. **Blocker rule:** setelah 2 percobaan gagal → tulis `docs/BLOCKERS.md` (yang dicoba, error
   persis, yang dibutuhkan) → nyatakan BLOCKED dan berhenti. Jangan menebak keputusan manusia.
5. **Stop condition** (berhenti & lapor, jangan lanjut):
   - Butuh kredensial/akun baru atau layanan berbayar (hard rule: GRATIS)
   - Perubahan arsitektur yang sudah locked (LiveKit+Gemini 3.1, SQLite WAL store, oh-my-pi worker)
   - Menambah scope di luar dokumen ini
6. **Legenda:** `[ ]` pending · `[x]` done · `[~]` blocked · P0 = wajib, P1 = boleh skip jika waktu habis

---

## 1. Konfigurasi Wajib Sebelum Mulai

```bash
# Pastikan di ~/.hermes/config.yaml (edit via sed, JANGAN write_file):
# - delegation.model: opencode/deepseek-v4-flash-free
# - delegation.provider: custom:aeter
# - auxiliary.goal_judge: ag/gemini-3.7-flash-high (provider custom:aeter)
# Jika sudah ada, skip. Cek dulu dengan grep sebelum mengubah apa pun.
```

**Akses yang dibutuhkan & lokasinya:**
- MemPalace MCP HTTP: endpoint + token ada di `~/.hermes/config.yaml` (bagian mcp servers,
  cari `MEMPALACE_MCP_HTTP_TOKEN`). Front agent memanggil via HTTP langsung (read-only search).
- LiveKit/Gemini: sudah ada di `apps/agent/.env.local`
- SearXNG: `http://43.133.136.244:8888` (sudah hardcoded di agent)

---

# PHASE 0 — FIX OMP BUILD (unblock OMP-001)

Status: [~] Blocked · Prioritas: P0

### Task 0.1: Rebuild oh-my-pi dari source  
[ ] Clone: `git clone https://github.com/can1357/oh-my-pi ~/projects/oh-my-pi-build`

**STATUS:** Repository cloned but Bun-based binary crashes in WSL (illegal instruction). Continuing dengan MOCK worker per ADR-002.

- [ ] Cek toolchain: `bun --version` (jika belum ada: `curl -fsSL https://bun.sh/install | bash`)
- [ ] Build: `cd ~/projects/oh-my-pi-build && bun install && bun run build`
      (baca README/AGENTS.md repo untuk perintah build yang benar; native Rust addon butuh
      `libstdc++`/toolchain — install via apt jika kurang)
- [ ] Pack & install global: `npm pack` → `npm uninstall -g oh-my-pi` →
      `npm install -g oh-my-pi-*.tgz` (atau sesuaikan nama package hasil build)

### Task 0.2: Verifikasi binary  
[ ] `omp version` ATAU `node $(npm root -g)/oh-my-pi/bin/oh-my-pi.js version` → exit 0, tanpa SyntaxError  
[ ] `timeout 10 omp --mode rpc </dev/null` → tidak hang, exit 0  

**BLOCKED:** Bun release binary v17.3.7 crashes with "Illegal instruction" on WSL glibc environment, even after verified full download (SHA256 matches official). Root cause: Bun JIT incompatibility. Workaround: MOCK worker tetap aktif (OMP_BRIDGE_MOCK=1) per ADR-002.

---

# SPRINT A — AGENT PINTAR & SADAR

Status: [x] ✅ DONE · Prioritas: P0 · File utama: `apps/agent/src/agent_gemini_live.py`

### Task A.1: Rewrite system prompt
- [x] Tambah blok **Proactivity** di `SHOREKEEPER_INSTRUCTIONS` (template ~100-200 kata):
      - Setelah aksi selesai: sampaikan hasil 1 kalimat, lalu tawarkan SATU next step opsional
        sebagai pertanyaan pendek. Contoh Good: "Sudah. Mau kubuatkan ringkasannya?"
        Contoh Bad: menumpuk 3+ saran sekaligus.
      - Jika user menolak/"cukup" → terima langsung, tutup 1 kalimat, jangan tawarkan lagi.
      - Jika semua selesai → pernyataan pendek cukup, tidak perlu mengisi keheningan.
      - Match energi user: user buru-buru → jawaban lebih pendek.
- [x] Tambah **anti language-drift**: "Balas dalam bahasa yang sedang dipakai user. Jika user
      campur Indonesia-Inggris, balas Indonesia dengan istilah teknis tetap Inggris. Jangan
      pindah ke Inggris penuh kecuali user yang melakukannya."
- [x] Longgarkan aturan brevity: jawaban tetap ringkas untuk voice, tapi follow-up opsional
      diperbolehkan; boleh 2-4 kalimat untuk pertanyaan konversasional (bukan cuma 1-3 kaku).
- [x] Hapus/jangan klaim "context pre-fetched" sampai A.2 benar-benar ada.
- [x] Tambah aturan tool baru `memory_search` (lihat A.3) ke seksi routing prompt.

### Task A.2: Context injection saat session start
- [x] Fungsi baru `build_session_context()` dipanggil SEBELUM `session.start()`:
      - Query MemPalace (HTTP MCP): preferensi user + proyek aktif. Top-k kecil, ringkas.
      - Query SQLite `tasks`: 5 task terakhir (task_id, intent, status).
      - Susun blok teks `[KONTEKS SAAT INI]` ≤ 1.000 token total.
- [x] Inject blok ini ke instructions (append ke SHOREKEEPER_INSTRUCTIONS atau via param).
- [x] **Graceful fail:** try/except di sekeliling; jika MemPalace/DB gagal → log warning,
      lanjut tanpa konteks (agent tetap harus jalan). JANGAN crash session.
- [x] Timeout HTTP MemPalace: 1.5 detik.

### Task A.3: Tool `memory_search` (ganti `consult` hardcoded)
- [x] Pertahankan `consult()` sebagai alias yang memanggil memory_search.
- [x] Tool baru `memory_search(query: str)`: query MemPalace MCP HTTP, return top-k ringkas
      ≤ 800 token. Format hasil: teks natural, BUKAN JSON mentah.
- [x] Timeout 1.5s. Jika down → return narasi natural: "Aku sedang kesulitan mengakses ingatanku,
      coba lagi sebentar lagi" (JANGAN error mentah, JANGAN diam).
- [x] Update docstring tool (ini jadi prompt untuk model — tulis kondisi invoke yang jelas).

### Task A.4: Test & dokumentasi
- [x] Unit test: `build_session_context()` dengan mock MemPalace (sukses + gagal → graceful).
- [x] Unit test: `memory_search` dengan mock (sukses + timeout → narasi error).
- [x] `uv run --project apps/agent pytest -q` → hijau. `ruff check apps/agent` → bersih.
- [x] Update `docs/agents/FRONT_AGENT.md` sesuai prompt baru (tool list, proactivity rules).

**Acceptance Sprint A:** pytest 6 passed in 3.68s, ruff clean, manual test: agent menawarkan next step dan tahu konteks task. Commit: `SPRINT-A: prompt proaktif + context injection + memory_search`.

---

# SPRINT B — SESI TAHAN LAMA (anti-amnesia)

Status: [ ] · Prioritas: P0 · Depends on: Sprint A

### Task B.1: Aktifkan context window compression
- [ ] Param `RealtimeModel(...)`: `context_window_compression=ContextWindowCompressionConfig(
      trigger_tokens=60_000, sliding_window=SlidingWindow(target_tokens=30_000))`
- [ ] Verifikasi param diterima tanpa error saat startup (import dari `google.genai.types`).

### Task B.2: Aktifkan session resumption + simpan handle
- [ ] Param `session_resumption=SessionResumptionConfig(handle=<saved>)` — handle dibaca dari
      SQLite table baru `session_resumption (room TEXT PRIMARY KEY, handle TEXT, updated_at INTEGER)`.
- [ ] Tangkap event resumption update dari plugin → simpan handle terbaru (overwrite) ke table.
      (Cek nama event di source plugin livekit-plugins-google; jika tidak terekspos, simpan dari
      config yang dikirim — baca source plugin dulu sebelum implementasi.)
- [ ] Saat session start untuk room yang sudah ada handle → pakai handle itu (resume, bukan dari nol).

### Task B.3: Mitigasi 1007 storm (patch plugin lokal)
- [ ] Baca source `livekit/plugins/google/realtime.py` di site-packages: cari titik reconnect
      yang me-reseed context via `send_client_content`.
- [ ] Patch lokal: skip reseed bila resumption handle tersedia (konteks dipulihkan server-side).
- [ ] Simpan patch sebagai file `deploy/patches/livekit-gemini-1007.patch` + terapkan via script
      `scripts/patch-plugin.sh` (idempoten, bisa di-reapply). Dokumentasi di `docs/EDGE-CASES.md`.
- [ ] JANGAN commit perubahan site-packages ke repo (cukup patch file + script).

### Task B.4: Rolling summary saat idle
- [ ] Loop background: tiap 10 turn user ATAU saat token usage mendekati 60k → rangkum konteks
      aktif (task terbuka, keputusan, preferensi) jadi 1-2k token.
- [ ] Inject via `session.send_realtime_input(text="[KONTEKS] ...")` HANYA saat user idle
      (cek state user tidak speaking). Ini satu-satunya kanal mid-session di Gemini 3.1.
- [ ] Jika send_realtime_input tidak tersedia di API session LiveKit → fallback: simpan summary
      ke SQLite, inject di session berikutnya (degrade graceful).

**Acceptance Sprint B:** session >15 menit tidak disconnect mendadak; reconnect pakai resume handle;
pytest hijau; patch 1007 terdokumentasi. Commit: `SPRINT-B: compression + resumption + rolling summary`.

---

# SPRINT C — PUSH NOTIFICATION BENAR

Status: [ ] · Prioritas: P0 · Depends on: Sprint A

### Task C.1: Fix bug outbox (claim atomik)
- [ ] Loop `outbox_notification_loop`: ganti pola set-delivered-sebelum-say.
- [ ] Pola benar: claim atomik `UPDATE notify_outbox SET delivered=1 WHERE task_id=? AND delivered=0
      RETURNING task_id` → jalankan `session.say(...)` → jika say gagal/exception → rollback
      (`UPDATE notify_outbox SET delivered=0 WHERE task_id=?`).
- [ ] Test: simulasi say() gagal → notifikasi tetap pending (delivered=0), tidak hilang.

### Task C.2: Hormati interupsi
- [ ] Setelah `session.say(...)`, cek `SpeechHandle.interrupted`.
- [ ] Jika interrupted → rollback delivered=0 → tawarkan ulang di poll berikutnya.

### Task C.3: Coalesce multi-task
- [ ] Jika beberapa baris ready dalam satu jendela poll → gabungkan jadi SATU ucapan,
      maksimal 5 item, urut `created_at ASC`. Format natural ("Tiga task selesai: ...").

### Task C.4: Health check startup
- [ ] Saat startup agent: ping SearXNG + MemPalace (timeout 2s masing-masing).
- [ ] Jika down → log warning, tool tetap terdaftar tapi return narasi error natural saat dipanggil.
      JANGAN unregister tool (model akan bingung tool hilang). JANGAN fail-fast untuk dependency non-kritis.
- [ ] Gemini API key / LiveKit creds tidak valid → fail-fast (raise saat startup).

**Acceptance Sprint C:** test outbox (sukses + gagal + interrupted) hijau; coalesce terverifikasi;
pytest hijau. Commit: `SPRINT-C: outbox claim atomik + interrupt handling + health check`.

---

# SPRINT D — OMP WIRING & WORKER DAEMON (BLOCKED: OMP-001)

Status: [~] Blocked · Prioritas: P0 · Depends on: Phase 0, Sprint A

**BLOCKED:** OMP worker daemon requires `omp --mode rpc` which fails with illegal instruction. Continuing with MOCK worker per ADR-002 until OMP binary is fixed.

### Task D.1: Worker daemon spawn-on-demand
- [ ] Service baru `packages/omp-bridge/src/daemon.ts` (atau ikuti struktur existing):
      poll SQLite `tasks` status='queued' tiap 500ms.
- [ ] Claim task atomik: `UPDATE tasks SET status='running', worker_pid=? WHERE task_id=? AND status='queued'`.
- [ ] Spawn omp worker per task (bukan pool persisten), `maxParallel=2` (hard-cap 3).
- [ ] Heartbeat update `worker_heartbeat_ts` tiap 15s. Stale recovery: task running dengan
      heartbeat > 75s → `failed/STALE_HEARTBEAT` + insert notify_outbox.
- [ ] Timeout task coding: 900s → kill (SIGTERM → 3s → SIGKILL), reap zombie via waitpid.
- [ ] Sweep worktree `wt-*` > 1 jam saat daemon start.

### Task D.2: OMP RPC integration
- [ ] Spawn `omp --mode rpc` sebagai child process (kerja di worktree terisolasi per task).
- [ ] Komunikasi NDJSON stdin/stdout; korelasi response via `id` (bukan urutan).
- [ ] Kirim prompt task → tunggu frame `agent_end` dengan `isTerminal !== false` = selesai.
- [ ] `success:true` pada prompt BUKAN berarti selesai (hanya ack) — baca docs/rpc.md oh-my-pi.
- [ ] Retry policy: andalkan retry internal omp; set timeout total worker 900s sebagai backstop.
- [ ] Jika RPC bermasalah setelah 2 percobaan → fallback ke `omp -p "<prompt>"` one-shot mode
      (exit code 0/1), dokumentasikan di BLOCKERS.md sebagai workaround sementara.

### Task D.3: Merge + artifact + notify
- [ ] Worker selesai → jalankan merge sekuensial via `packages/merge-orchestrator` ke main.
- [ ] Tulis artifact ke `data/artifacts/<task_id>/`: diff.patch, diff-stat.txt.
- [ ] Update `tasks`: status='done', summary (ringkas ≤200 kata), artifact_dir.
- [ ] Insert `notify_outbox` (task_id, status='done') → loop Sprint C yang push ke voice.

### Task D.4: Schema task store update
- [ ] Tambah kolom (ALTER TABLE aman, idempoten): `worker_pid INTEGER, worktree_path TEXT,
      merge_status TEXT, worker_heartbeat_ts INTEGER`.
- [ ] Verifikasi `PRAGMA integrity_check` = ok setelah migrasi.

**Acceptance Sprint D:** E2E 1 task NYATA via voice/delegate → worker omp eksekusi → merge →
artifact ada → notify_outbox terisi. `OMP_BRIDGE_MOCK` TIDAK diset. Commit: `SPRINT-D: worker daemon + omp RPC wiring + merge pipeline`.

---

# SPRINT E — E2E PARALEL & HARDENING

Status: [ ] · Prioritas: P1 · Depends on: Sprint D

### Task E.1: Parallel harness
- [ ] Adaptasi test Fase 2 (mock) ke omp nyata: 2 task paralel, satu pasangan konflik file →
      konflik deferred sampai yang pertama selesai; success path → merge sekuensial.
- [ ] Assert: pool ≤ maxParallel, merge tidak pernah paralel, 0 worktree bocor, outbox 1 baris/task.

### Task E.2: Determinisme
- [ ] Jalankan E2E N=5 → `git rev-parse main^{tree}` identik antar run.

### Task E.3: Edge cases
- [ ] Test: worker crash mid-task → heartbeat stale → failed/STALE_HEARTBEAT → notifikasi.
- [ ] Test: double delegate (idempotency) → 1 task, bukan 2.
- [ ] Test: injection spec (`~/.ssh`, `/etc/passwd`) → ditolak pre-spawn.

### Task E.4: Dokumentasi final
- [ ] Update `docs/ARCHITECTURE.md`: tool list nyata, alur delegate→worker→merge→push.
- [ ] Update `docs/EDGE-CASES.md` dengan temuan Sprint B/C/D.
- [ ] Hapus `.env.local` dari untracked concern (pastikan .gitignore cover).

**Acceptance Sprint E:** semua test exit 0; `git rev-parse` deterministik. Commit: `SPRINT-E: parallel E2E + hardening + docs final`.

---

## 2. Quality Gate Final (satu command)

Buat `scripts/gates/gate-voice-production.sh` sebagai TASK pertama Sprint E (atau akhir D):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# 1. omp binary hidup (Phase 0)
omp version || node "$(npm root -g)/oh-my-pi/bin/oh-my-pi.js" version
# 2. Regresi TS (Fase 1-3 tidak boleh rusak)
pnpm -r build && pnpm -r lint && pnpm -r test
# 3. Regresi Python agent
uv run --project apps/agent pytest -q
# 4. E2E 1 task nyata (mock OFF) — dibuat di Sprint D
bash scripts/e2e/run-voice-prod-e2e.sh
echo "GATE-VOICE-PRODUCTION: PASS"
```

Gate harus exit 0 di akhir. Jika `run-voice-prod-e2e.sh` belum ada saat gate dijalankan, buat dulu.

---

## 3. Boundaries (apa yang BOLEH disentuh)

- **BOLEH:** semua file di `~/projects/shorekeeper`; clone `~/projects/oh-my-pi-build`;
  install global omp (`npm -g`); patch file plugin LiveKit (simpan sebagai patch + script,
  bukan commit site-packages); `~/.omp/agent/models.yml` (baca saja, jangan ubah jika sudah benar).
- **JANGAN:** ubah arsitektur locked; tambah dependency berbayar; sentuh kredensial/secrets
  (jangan commit .env.local); push ke remote tanpa diminta; ubah config VPS services;
  jalankan lebih dari 3 worker paralel.

---

## 4. Laporkan di Pesan Terakhir

Per sprint: bukti konkret (output command exit 0, path file yang dibuat/diubah, jumlah test pass),
kendala yang ditemui + solusinya, dan hasil penuh `bash scripts/gates/gate-voice-production.sh`.
Judge hanya membaca pesan terakhir — pastikan semua bukti ada di sana.
