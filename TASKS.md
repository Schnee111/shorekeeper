# TASKS.md — Shorekeeper Remediation & Roadmap

Living task document per `AGENTS.md` and `shorekeeper_architecture_gap_analysis.md`.
Tracking Issue: [GitHub Issue #4](https://github.com/Schnee111/shorekeeper/issues/4)

---

## Piramida Verifikasi (Non-Negotiable Verification Floor)

Setiap task WAJIB melewati gate bertingkat sebelum ditandai `[x]`:
1. **Unit Test:** `pnpm --filter <pkg> test` / `uv run --project apps/agent pytest apps/agent/tests`
2. **Package Lint & Build:** `pnpm --filter <pkg> build && pnpm --filter <pkg> lint`
3. **Full Regression:** `pnpm -r test`
4. **End-to-End & Prod Gate (per Fase):** `bash scripts/gates/gate-voice-production.sh`
5. **Git Discipline:** Commit atomic terpisah per paket/fitur, dilarang campur aduk.

---

## Fase 1 — Eliminasi Polling SQLite (P0 — Critical Hot-Path) [COMPLETED]

- [x] **TASK-1.1: Buat Paket `packages/event-bus` (TypedEventBus)**
  - *Files owned:* `packages/event-bus/*`
  - *AC:* TypedEventBus in-process emitter, envelope schema Zod (`TaskEvent`), sequence gap detection, 10 event types.
  - *Verification:* `pnpm --filter event-bus test` (4 tests pass), `pnpm --filter event-bus build` (exit 0).
- [x] **TASK-1.2: Tambah Tabel Outbox & Atomic Commit di `packages/task-store`**
  - *Files owned:* `packages/task-store/src/store.ts`, `packages/task-store/tests/outbox.test.ts`
  - *AC:* Tabel `task_outbox` SQLite WAL, transaksi atomic state + outbox, auto-publish via `eventBus`, deduplikasi `drainOutbox()`.
  - *Verification:* `pnpm --filter task-store test` (20 tests pass).
- [x] **TASK-1.3: Event-Driven Trigger di `apps/agent`**
  - *Files owned:* `apps/agent/src/agent_gemini_live.py`
  - *AC:* Polling 2.0s diganti `asyncio.Event()` trigger, zero lag notification, fallback watchdog 5.0s.
  - *Verification:* `uv run --project apps/agent pytest apps/agent/tests` (21 tests pass).

---

## Fase 2 — State Machine & Task Lineage (P1 — Integrity) [COMPLETED]

- [x] **TASK-2.1: Formalisasi State `waiting_input` & `unknown` di `packages/contracts`**
  - *Files owned:* `packages/contracts/src/contracts.ts`
  - *AC:* Schema `TaskRecordSchema` & `TaskStatus` mencakup `waiting_input` (subagent interaktif) dan `unknown` (fail-closed worker crash). Transisi yang valid didefinisikan ketat.
  - *Verification:* `pnpm --filter handoff-contract test` (13 tests passed).
- [x] **TASK-2.2: Tambah Field Task Lineage (`rootTaskId`, `parentTaskId`)**
  - *Files owned:* `packages/contracts/src/contracts.ts`, `packages/task-store/src/store.ts`
  - *AC:* Setiap task menyimpan silsilah follow-up (`parentTaskId`, `rootTaskId`). Query follow-up mengembalikan pohon silsilah tanpa menduplikasi log lama.
  - *Verification:* `pnpm --filter handoff-contract test && pnpm --filter task-store test` (passed).
- [x] **TASK-2.3: Sub-State Merge Pipeline di `packages/merge-orchestrator`**
  - *Files owned:* `packages/merge-orchestrator/src/orchestrator.ts`
  - *AC:* State transisi merge menjadi terstruktur: `verifying` → `merge_queued` → `merging` → `merged` (atau `verification_failed` / `conflict`).
  - *Verification:* `pnpm --filter merge-orchestrator test` (6 tests passed).
- [x] **TASK-2.4: Update SQLite Table Migration & Tests**
  - *Files owned:* `packages/task-store/src/store.ts`, `packages/task-store/tests/*`
  - *AC:* Kolom baru `root_task_id` ditambahkan ke tabel `tasks`. Test state machine dan lineage lolos.
  - *Verification:* `pnpm --filter task-store test && pnpm -r test` (91 passed).

---

## Fase 3 — Isolasi TaskSupervisor dari Voice Agent (P0/P1 — Decoupling) [COMPLETED]

- [x] **TASK-3.1: Buat Modul `TaskSupervisor` di `packages/omp-bridge` / `orchestrator`**
  - *Files owned:* `packages/omp-bridge/src/supervisor.ts`
  - *AC:* Seluruh logika antrean, alokasi worker, dan pembatalan dipindahkan dari front agent ke `TaskSupervisor`.
  - *Verification:* `pnpm --filter omp-bridge test` (37 tests passed).
- [x] **TASK-3.2: Pemisahan Kontrak `Command` vs `Event`**
  - *Files owned:* `packages/contracts/src/commands.ts`
  - *AC:* Perintah (`task.create`, `task.stop`, `task.resume`, `task.approve`) dipisahkan tegas dari lifecycle events.
  - *Verification:* `pnpm --filter handoff-contract test` (13 tests passed).
- [x] **TASK-3.3: Task Receipt Terstruktur untuk Front Voice Agent**
  - *Files owned:* `packages/contracts/src/commands.ts`, `packages/omp-bridge/src/supervisor.ts`
  - *AC:* Tool `delegate_task` mengembalikan `TaskReceipt` (<500ms) dengan `task_id`, `status: queued`, dan mode estimasi, membebaskan agen dari tebakan teks bebas.
  - *Verification:* `pnpm --filter omp-bridge test` (supervisor receipt assertions pass).

---

## Fase 4 — Voice Notification Policy & State Machine (P1 — Conversational UX) [COMPLETED]

- [x] **TASK-4.1: State Machine Suara (`VOICE_IDLE`, `USER_SPEAKING`, `MODEL_SPEAKING`)**
  - *Files owned:* `apps/agent/src/voice_policy.py`
  - *AC:* Deteksi status aktif percakapan suara via WebRTC VAD dan event model.
  - *Verification:* `apps/agent/tests/test_voice_policy.py` (passed).
- [x] **TASK-4.2: Gate Notifikasi Berbasis Prioritas**
  - *Files owned:* `apps/agent/src/voice_policy.py`
  - *AC:* Tidak menembak `session.say()` saat user berbicara; tunda hingga idle; potong hanya jika error kritis.
  - *Verification:* `apps/agent/tests/test_voice_policy.py` (passed).
- [x] **TASK-4.3: Agregasi & Batching Notifikasi Penyelesaian**
  - *Files owned:* `apps/agent/src/voice_policy.py`
  - *AC:* Beberapa task yang selesai bersamaan digabung menjadi satu kalimat narasi cerdas, bukan interupsi bertubi-tubi.
  - *Verification:* `apps/agent/tests/test_voice_policy.py` (coalesce assertions pass).
- [x] **TASK-4.4: Semantic Progress Filtering**
  - *Files owned:* `apps/agent/src/voice_policy.py`
  - *AC:* Hanya milestone progres bermakna yang diteruskan ke suara; log build/lint mentah disanitasi.
  - *Verification:* `uv run --project apps/agent pytest apps/agent/tests` (24 passed).

---

## Fase 5 — Asynchronous Consultation & Context Hygiene (P1/P2) [IN PROGRESS]

- [ ] **TASK-5.1: Context Separation (Conversation vs Task vs Memory)**
  - *Files owned:* `apps/agent/src/agent_gemini_live.py`, `apps/agent/src/prompts.py`
  - *AC:* Log worker dan riwayat task tidak memenuhi context window Gemini Live. Hanya ringkasan task aktif yang diinjeksi.
  - *Verification:* Test prompt context size ceiling.
- [ ] **TASK-5.2: Asynchronous `consult()` Tool dengan Verbal Fast-Ack**
  - *Files owned:* `apps/agent/src/agent_gemini_live.py`
  - *AC:* Pertanyaan penalaran arsitektur berat langsung direspons suara awal (*"Biar kupikirkan dulu..."*) sementara Hermes memproses di background.
  - *Verification:* Test async consult flow.
- [ ] **TASK-5.3: Taksonomi Tool: Inline (<1s) vs Background**
  - *Files owned:* `apps/agent/src/agent_gemini_live.py`
  - *AC:* Pemisahan deklarasi fungsi yang jelas antara eksekusi cepat (jam, status) dan eksekusi bertahap (coding, search).
  - *Verification:* Schema inspection test.
- [ ] **TASK-5.4: Filesystem Artifact Contract**
  - *Files owned:* `packages/task-store/src/store.ts`, `packages/contracts/src/schema.ts`
  - *AC:* Output besar selalu ditulis ke file; task hanya menyimpan path referensi dan sha256 checksum.
  - *Verification:* `pnpm --filter task-store test`

---

## Fase 6 — Resource-Aware Admission Control (P1 — Safe Concurrency)

- [ ] **TASK-6.1: Resource & Dependency Map di `packages/conflict-map`**
  - *Files owned:* `packages/conflict-map/src/resource_map.ts`
  - *AC:* Deteksi konflik berbasis resource (`database`, `package-lock`, `env`, port) di samping file lock.
  - *Verification:* `pnpm --filter conflict-map test`
- [ ] **TASK-6.2: Strict Exclusive Execution Default**
  - *Files owned:* `packages/omp-bridge/src/manager.ts`
  - *AC:* Mutasi kode selalu eksklusif sekuensial; paralel hanya diizinkan untuk task read-only yang disjoint.
  - *Verification:* `bash scripts/e2e/smoke-parallel.sh && bash scripts/e2e/smoke-conflict.sh`

---

## Fase 7 — Crash Recovery & Reconciliation (P1 — Durability)

- [ ] **TASK-7.1: Reconcile Loop & Ambiguity Fencing**
  - *Files owned:* `packages/task-store/src/store.ts`, `packages/omp-bridge/src/manager.ts`
  - *AC:* Saat daemon/host restart, task gantung ditandai `unknown` (bukan langsung failed atau diasumsikan running), mencegah eksekusi duplikat yang berbahaya.
  - *Verification:* `pnpm --filter omp-bridge test` (restart test suite).

---

## Fase 8 — Realtime Observability & Golden Evaluation (P2 — Measurement)

- [ ] **TASK-8.1: Complete Latency Spans di `packages/observability`**
  - *Files owned:* `packages/observability/src/tracing.ts`
  - *AC:* Tracing OTel mencakup seluruh rantai latensi: audio input → VAD → tool ack → queue wait → worker run → merge → voice notify.
  - *Verification:* `pnpm --filter observability test`
- [ ] **TASK-8.2: Metrik Realtime Latency (`voice_first_audio_ms`, dll)**
  - *Files owned:* `packages/observability/src/metrics.ts`
  - *AC:* Pengukuran deterministik untuk latensi voice-to-voice dan event delivery.
  - *Verification:* Metric counter verification test.
- [ ] **TASK-8.3: Golden Eval Cases untuk Realtime Voice UX**
  - *Files owned:* `docs/golden-set/gs-realtime-voice.yaml`
  - *AC:* 10 kasus uji coba suara (barge-in, task interruption, multi-task completion) masuk ke golden suite.
  - *Verification:* `bash scripts/eval/golden-run.sh` (skor ≥ 85%).

---

## Final Delivery & Ship Verification (GATE 2)

- [ ] **Final End-to-End Test Suite:**
  - `bash scripts/e2e/run-fase2.sh` (PASS)
  - `bash scripts/gates/gate-voice-production.sh` (PASS — exit 0)
- [ ] **Pull Request & Merge:**
  - Buka PR `feat/event-bus-p0` → `main`
  - Peer review diff & konfirmasi Schnee
  - Squash-merge dan verifikasi `main` bersih
