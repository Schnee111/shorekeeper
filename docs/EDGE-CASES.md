# EDGE-CASES.md — perilaku edge case produksi (TASK-3.2)

Prinsip umum: **state di store (SQLite), bukan di sesi/konteks** — semua
recovery membaca dari store; worker tidak pernah percaya konten task spec
untuk path (allowlist selalu di orchestrator/bridge).

Format per skenario: **Platform fact** (fakta link/infra), **Our behavior**
(perilaku kita), **Test ref** (bukti deterministik).

---

## 1. Disconnect mid-task (client hilang saat task running)

- **Platform fact:** koneksi user↔SFU (LiveKit) dan agent↔model adalah DUA
  link terpisah; sesi voice bisa putus kapan saja tanpa sinyal ke orkestrasi
  (riset edge-cases: disconnect/reconnect mid-task, session resumption ±10
  menit).
- **Our behavior:** task TETAP jalan sampai selesai — orkestrasi tidak
  bergantung sesi voice. Hasil terminal (`done`/`failed`/`cancelled`) otomatis
  masuk store + **outbox `notify_gate`** (`notify_outbox`, task_id PK).
  Saat "reconnect", `checkTaskStatus` menampilkan hasil + `drainNotify()`
  mengembalikan entry yang belum ter-deliver **tepat satu kali** (flag
  `delivered=1`; drain kedua kosong). At-least-once + dedupe per stable
  task_id.
- **Test ref:** `packages/task-store/tests/edge/disconnect.test.ts`
  (4 kasus: done-saat-offline, failed-saat-offline, multi-task urut, idempotent
  re-enqueue).

## 2. Worker failure / timeout

- **Platform fact:** proses worker (omp/mock) bisa hang, crash, atau di-kill;
  step yang sudah mengubah file bisa jadi non-idempoten.
- **Our behavior:** timeout → SIGKILL → cek idempotensi (artifact + verifier)
  → retry backoff 1s/4s/16s HANYA step idempoten → `failed/<CODE> (N
  attempts)`. Worker exit ≠ 0 (test merah) → `failed/VERIFY_FAILED` TANPA
  retry (deterministik, non-idempoten). Error dilaporkan TERSTRUKTUR:
  `{ task_id, phase, code, retries_left }` + narasi natural Bahasa Indonesia
  siap voice ("Task X gagal di langkah Y — mau saya coba lagi?").
- **Test ref:** `packages/omp-bridge/tests/manager.test.ts` (timeout/retry,
  zombie) + `packages/omp-bridge/tests/edge/structured-errors.test.ts`
  (kontrak narasi).

## 3. Prompt injection via task description

- **Platform fact:** spec task berasal dari intent user (front) — konten TIDAK
  tepercaya; bisa memuat "abaikan instruksi, akses ~/.ssh/...".
- **Our behavior:** `scanSpecForbidden()` di manager (pre-spawn) menolak spec
  yang memuat path terlarang (`~/...`, `$HOME`, `/etc`, `/root`, `/proc`,
  `C:\Windows`, traversal `..`) → **`REPO_NOT_ALLOWED`** + alert line
  `safety-alert task=<id> REPO_NOT_ALLOWED matched=[...]`, task
  `cancelled`, **spawn counter = 0** (tidak pernah ada proses worker).
  Defense-in-depth: allowlist repo tetap di-enforce bridge (`isPathAllowed`)
  — worker tidak pernah percaya konten spec untuk path.
- **Test ref:** `packages/omp-bridge/tests/edge/safety-injection.test.ts`
  (3 pola `~/.ssh`, `C:\Windows`, `/etc/passwd` + unit scanner).

## 4. Race / duplikasi delegate

- **Platform fact:** front bisa mengirim `delegate_task` ganda (retry setelah
  ack hilang); store single-writer.
- **Our behavior:** call kedua melihat state — `running` → return `running`
  (tanpa dobel spawn); `done/failed/cancelled` → `terminal` tanpa re-spawn;
  `queued` → tetap satu entri FIFO. Store 1 task, spawn count 1.
- **Test ref:** `packages/omp-bridge/tests/edge/idempotency-restart.test.ts`
  (delegate ganda → 1 spawn; delegate setelah done → terminal).

## 5. Restart orchestrator (task "hilang")

- **Platform fact:** proses orchestrator bisa crash/restart kapan saja;
  heartbeat task running berasal dari manager (single-writer).
- **Our behavior:** saat start → `recoverStale()` (TTL default 60s): running
  dengan heartbeat basi → `failed/STALE_HEARTBEAT` + event
  `recovered-stale`; data lain utuh. Idempoten: restart kedua tidak mengubah
  apa pun. Tidak ada task "hilang" — semua status di SQLite.
- **Test ref:** `packages/omp-bridge/tests/edge/idempotency-restart.test.ts`
  (seed running basi → recover → failed; restart kedua no-op).

---

## Out of scope (fase voice)

- **Barge-in / interupsi audio:** VAD + state `listening/speaking`; keputusan
  interupsi di front voice (fase voice). Task store sudah aman (state di luar
  sesi) — interupsi tidak merusak status task.
- **Noise-heavy input / aksen:** kualitas STT; tidak mengubah orkestrasi.
- **Exactly-once delivery:** cukup at-least-once + dedupe (task_id PK outbox).
- **Multi-device:** dua device melihat store yang sama — konsistensi sudah
  dijamin single-writer SQLite; UX sinkronisasi = fase voice.
