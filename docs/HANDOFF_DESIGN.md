# HANDOFF_DESIGN.md — Desain jalur front-agent → orchestrator → coding worker → push voice

| | |
|---|---|
| **Status** | Draft v1 (riset + rekomendasi) |
| **Tanggal** | 2026-08-17 |
| **Fokus** | Transport delegasi, push completion ke voice, daemon hemat RAM, E2E paralel, failure catalog |
| **Ground truth** | `packages/task-store`, `packages/omp-bridge`, `packages/merge-orchestrator`, `apps/agent/src/agent_gemini_live.py`, `docs/adr/0002 & 0003`, `docs/DEPLOYMENT.md` |

Semua angka latency/RAM di bawah adalah **hasil ukur langsung** pada mesin ini
(bagian "Angka ukur") atau diambil dari konstanta kode. Budget RAM memakai target
**VPS 3.6 GB** sesuai `docs/DEPLOYMENT.md` (mesin dev ini 7.9 GB — jangan tertukar).

### Angka ukur (diambil saat riset ini)

| Metrik | Nilai | Sumber |
|---|---|---|
| SQLite WAL write+commit (single writer) | p50 **0.04 ms**, p99 0.16 ms | ukur, 200 iter |
| SQLite WAL read by PK | p50 **0.008 ms** | ukur |
| SQLite writer kedua (kontensi lock) | **16.6 ms** sekali | ukur |
| `task-store` CLI cold spawn | wall **~140 ms**, RSS **~60 MB** | ukur (`/usr/bin/time -v`) |
| Busy timeout default Python `sqlite3` | 5000 ms | ukur (pragma) |
| Hermes WS submit ack | normal **<50 ms**, timeout 30 s | `hermes_llm.py:21` |
| `AgentSession.say` | punya `allow_interruptions`, return `SpeechHandle` | probe signature |
| `RealtimeModel` | support `proactivity`, `session_resumption`, `tool_response_scheduling` | probe signature |

---

## 1. Evaluasi 3 opsi transport delegasi (voice front → orchestrator)

Konteks: `agent_gemini_live.py` hari ini melakukan **direct SQLite INSERT** pada
`delegate_task` (baris 183–192) dan **polling outbox tiap 2.0 s** pada
`outbox_notification_loop` (baris 305–344). Dua jalur lain yang tersedia di repo:
**Hermes WS** (`hermes_llm.py`, dipakai `agent.py`) dan **task-store CLI**
(`packages/task-store/src/cli.ts`, dipakai E2E).

### 1.1 Perbandingan head-to-head

| Kriteria | **A. SQLite (write + poll)** | **B. Hermes WS direct** | **C. task-store CLI** |
|---|---|---|---|
| Latency enqueue | **0.04 ms** (write) + pickup ≤ interval poll | **<50 ms** ack (normal) | **~140 ms** (spawn Node) |
| Latency completion→voice | ≤ **2.0 s** (interval poll, tunable) | push streaming <100 ms | n/a (CLI pull, bukan push) |
| Worst-case | poll interval (deterministik) | **30 s** ack-timeout saat gateway sibuk | ~140 ms + busy_timeout 5 s |
| Persistensi / survive restart | **YA — DB source of truth** | TIDAK (state di sesi WS) | YA (tulis ke DB juga) |
| Delivery guarantee | **at-least-once + dedupe** (outbox `task_id` PK) — sudah jadi | manual, belum ada | at-least-once via DB |
| Kopling lifecycle voice↔backend | **rendah** (decoupled) | **tinggi** — sesi voice mati = turn mati | rendah |
| RAM tambahan | **~0** (DB sudah shared) | socket WS per room + buffer gateway | **~60 MB per spawn** (transien) |
| Kelemahan fatal yang sudah tercatat | polling membuang CPU sedikit | keepalive **1011**, "stuck on thinking", **fd exhaustion** (komentar `hermes_llm.py`) | buang 60 MB + 140 ms per delegasi |

### 1.2 Analisis per opsi

**A. SQLite (rekomendasi).** DB sudah menjadi *single source of truth*: state
machine `canTransition`, `notify_outbox` + `drainNotify()` (dedupe per `task_id`),
`staleTasks()` recovery, backup online — semuanya sudah ada dan di-test
(`task-store` 18 test hijau). Write 0.04 ms membuat fast-ack **< 500 ms**
(kontrak `docs/api.md §3.3`) tercapai dengan margin 10.000×. Decoupled: task tetap
jalan saat sesi voice putus (ini justru requirement EDGE-CASES §1). Satu-satunya
"biaya" adalah latency pickup/notify = interval polling, yang deterministik dan
bisa di-tune.

**B. Hermes WS (tolak untuk delegasi).** Ini transport **turn LLM**, bukan transport
task. Komentar di `hermes_llm.py` sendiri mencatat tiga kelas kegagalan nyata:
keepalive 1011 saat gateway sibuk, "stuck on thinking" karena cached session_id basi,
dan fd-exhaustion. Mengikat delegasi task ke jalur ini berarti: (a) task hilang saat
socket putus, (b) latency ack bisa 30 s, (c) tidak ada persistensi. Tetap pakai WS
hanya untuk *turn percakapan* (itu memang fungsinya), bukan untuk handoff task.

**C. task-store CLI (tolak sebagai jalur utama, simpan untuk ops).** 60 MB RSS +
140 ms per spawn adalah pemborosan di VPS 3.6 GB padahal write DB hanya 0.04 ms.
CLI juga **melewati validasi zod** kalau front menulis SQL sendiri. Tapi CLI sangat
berharga untuk **debug manual + E2E + recovery ops** (sudah dipakai
`scripts/e2e/*.mjs`) → pertahankan, jangan hapus.

### 1.3 Rekomendasi konkret

> **Pakai A (SQLite write + poll) sebagai tulang punggung delegasi.** Tuning:

1. **Delegasi (front→orchestrator):** tetap direct write, tapi lewat satu helper
   Python tipis yang **mirror validasi zod** (`TaskRecordSchema`): enforce `lane`
   enum, `task_id` max 64 char, `status` awal selalu `queued`, `session_room` =
   `ctx.room.name`. Jangan biarkan front menulis SQL mentah tanpa validasi.
2. **Pickup poll orchestrator:** `daemon.ts` sekarang 1.0 s. Turunkan ke **500 ms**
   (worst-case pickup 0.5 s, CPU masih trivial — satu `SELECT ... WHERE status='queued'`
   di-index). Opsi lebih responsif: hybrid **write + wakeup** — front kirim `SIGUSR1`
   / tulis 1 byte ke pipe setelah INSERT untuk membangunkan daemon segera, fallback
   poll 500 ms bila sinyal hilang. Jangan < 250 ms (buang CPU tanpa manfaat nyata).
3. **Notify poll voice:** **1.0 s** (dari 2.0 s) agar completion terasa lebih cepat;
   tetap murah (query outbox ter-index `delivered`). Angka 1.0 s adalah sweet-spot:
   sub-2 s perceived latency tanpa beban.
4. **Jangan** pindahkan delegasi ke Hermes WS. Jangan spawn CLI per delegasi.

---

## 2. Push notification completion ke voice (outbox + `session.say`)

Kontrak sudah benar (`notify_outbox`, `task_id` PK, flag `delivered`). Implementasi
`outbox_notification_loop` saat ini punya **4 lubang**. Berikut pola yang benar +
penanganan tiap edge case.

### 2.1 Pola push yang benar (state machine notifier)

```
setiap poll (1.0 s):
  1. ATOMIC CLAIM dulu, baru bicara (jangan SELECT-then-UPDATE):
       UPDATE notify_outbox
          SET delivered=1, delivered_at=?
        WHERE delivered=0
          AND task_id IN (SELECT task_id FROM tasks WHERE session_room=?)
        RETURNING task_id, status            -- SQLite >= 3.35
     → hanya proses baris yang benar-benar ter-claim (rowcount>0).
  2. GATE dulu (lihat notify_gate): jika belum boleh bicara, JANGAN claim —
     biarkan delivered=0 supaya bisa di-claim ulang poll berikutnya.
     (Penting: claim dilakukan SETELAH gate lolos.)
  3. COALESCE semua claim dalam satu jendela jadi SATU ucapan.
  4. await session.say(..., allow_interruptions=True).
  5. Jika say GAGAL (sesi putus) → kembalikan delivered=0 (rollback) supaya
     ter-drain saat reconnect.
```

**Koreksi kritis vs kode sekarang:** kode saat ini men-set `delivered=1` **sebelum**
`session.say` dan **di luar** transaksi (baris 326–330), lalu memanggil `say` dalam
loop. Jika user disconnect di antara mark dan say, notifikasi **hilang permanen**.
Balik urutannya: gate → claim → say → (kalau gagal, un-claim).

### 2.2 Edge case dan angka konkretnya

| Edge case | Perilaku yang benar | Angka/parameter |
|---|---|---|
| **User sedang bicara** (barge-in) | Hormati `notify_gate`. `idle` → tunda sampai user & agent sama-sama tidak bicara. `next_turn` → sampaikan di turn berikutnya. `off` → buang (tetap di store, bisa ditarik `check_task_status`). | Gate cek state tiap poll 1.0 s; tunda maksimal sampai idle (tanpa timeout — hasil tetap aman di DB). |
| **User disconnect** | Jangan claim saat offline. Outbox `delivered=0` tetap terisi; saat reconnect, `drainNotify()` mengembalikan tepat-satu-kali. Task tetap jalan (orkestrasi tak tergantung sesi voice). | Reconnect drain sekali; `drainNotify()` kedua = kosong (dedupe). |
| **Double delivery** | Klaim atomik `UPDATE ... WHERE delivered=0 RETURNING` — dua poller/reconnect yang race tidak mungkin sama-sama dapat baris yang sama. | Rowcount=0 → skip. |
| **Urutan multi-task selesai bersamaan** | Coalesce dalam satu jendela poll: baca **≤ 5** keras (kontrak `checkTaskStatus`), sisanya dirangkum 1 baris "…dan N task lainnya". Urutan = `created_at ASC` lalu `task_id ASC` (sama dengan `drainNotify`). | Batch ≤ 5 narasi; kalau 3 task selesai dalam 1 jendela → 1 ucapan gabungan, bukan 3 `say` bertumpuk. |

### 2.3 Rekomendasi konkret

1. **`allow_interruptions=True`** untuk notifikasi proaktif — user boleh memotong;
   detail tetap bisa diminta ulang via `check_task_status` (data aman di store).
   Ini mencegah notifikasi "mengomel" menimpa ucapan user.
2. **Hormati `notify_gate`** (field sudah ada di kontrak tapi diabaikan kode).
   Default `next_turn`; task kritis bisa `idle`; task noisy bisa `off`.
3. **Coalesce window = 1 jendela poll (1.0 s).** Tiga worker selesai bersamaan →
   satu ucapan gabungan: *"Schnee, tiga task selesai sekaligus: …"* — bukan tiga
   `say` beruntun yang saling menumpuk di TTS.
4. **Rollback-on-failure:** `say` gagal → `UPDATE ... SET delivered=0` agar
   tidak hilang. Ini menutup lubang disconnect-mid-delivery.
5. Aktifkan **`session_resumption`** pada `RealtimeModel` (tersedia, probe
   signature) agar sesi Gemini bertahan ±10 menit sesuai riset edge-case, sehingga
   reconnect singkat tidak kehilangan konteks notifikasi.

---

## 3. Desain worker daemon hemat RAM (VPS 3.6 GB)

### 3.1 Spawn-on-demand vs pool — keputusan: **on-demand spawn + lightweight resident manager**

`docs/DEPLOYMENT.md` sudah tegas: *"omp worker ~200–400 MB — **on-demand, JANGAN
daemon**"*. Alasannya kuantitatif:

| Skenario | RAM worker | Total estimasi* |
|---|---|---|
| Baseline (tanpa worker) | 0 | ~1.6 GB |
| 2 worker × 400 MB | 0.8 GB | ~2.4 GB |
| 3 worker × 400 MB | 1.2 GB | ~2.8 GB |

\* baseline = orchestrator 480 + node manager/store 300 + front live 500 + OTel 350
(angka DEPLOYMENT.md). 3.6 GB - 2.8 GB = **headroom ~0.8 GB** → ketat.

**Rekomendasi:**
- **Resident:** hanya *manager/orchestrator* (pegang pool, FIFO, merge gate,
  heartbeat writer) — ~300 MB. Ini memang harus selalu hidup.
- **Worker coding:** **spawn-on-demand**. Jangan pre-warm/hold worker idle —
  menahan 3×400 MB tanpa kerja = buang 1.2 GB. `WorkerManager.slots` sudah
  spawn per dispatch; pertahankan.
- **`maxParallel` default di VPS = 2**, naikkan ke **3 hanya jika** OTel dimatikan
  atau headroom RAM terbukti > 1 GB. Hard-cap kode tetap 3
  (`MAX_PARALLEL_HARD_CAP`), tapi *default operasi* 2.

### 3.2 Lifecycle per task (sudah benar di `manager.ts`, pertahankan)

```
queued → [slot kosong & ownership bebas] → running (spawn worktree --detach)
       → heartbeat tiap interval oleh MANAGER
       → exit 0 → commit worktree → branch worker/<id> → merge gate (onWorkerReady)
       → merge hijau → done  |  verifier merah → failed/VERIFY_FAILED (no retry)
       → timeout → SIGKILL → cek idempotensi → retry backoff → failed/<CODE> (N attempts)
```

Slot **ditahan sampai merge gate selesai** (`manager.ts:633-636`) — ini penting agar
release ownership terjadi *sebelum* task ter-defer berikutnya jalan. Pertahankan.

### 3.3 Heartbeat & timeout untuk task coding 2–15 menit

| Parameter | Nilai sekarang | **Rekomendasi** | Alasan |
|---|---|---|---|
| Heartbeat interval (manager→store) | 30 s | **15 s** | Task panjang (15 menit) butuh deteksi mati lebih cepat; 15 s masih murah (1 UPDATE/15 s). |
| Stale TTL | 60 s | **75 s** (= 5× interval) | Toleransi 3–4 heartbeat meleset di VPS yang lagi load; hindari false-positive stale saat CPU spike. |
| Timeout per attempt | 300 s (mock) | **900 s (15 menit)** untuk lane coding nyata | Task 2–15 menit; 300 s akan memangkas task 15 menit. Keep 300 s untuk mock/E2E. |
| Retry | [1 s, 4 s], max 3 attempts | **pertahankan**, hanya step idempoten | Sudah benar; `checkLanded` mencegah re-run yang sudah landing. |

> Heartbeat ditulis **oleh manager**, bukan worker (`manager.ts:743-748`) — keputusan
> tepat: worker crash tidak bisa memalsu liveness. Pertahankan.

### 3.4 Cleanup worktree & zombie

- **Worktree:** `removeWorktree` sudah idempoten (remove → fallback `rm -rf` →
  `prune`). Tambah **sweep saat start**: `git worktree prune` + hapus dir
  `wt-*` yang umurnya > **1 jam** dan tidak punya task running (tangkap bocor dari
  crash keras). Jalankan di `start()` setelah `recoverStale()`.
- **Zombie:** `runWorker` sudah pakai event `'exit'` (bukan `'close'`) sehingga tidak
  hang nunggu fd (`index.ts:216-222`). Escalation: `SIGTERM` → tunggu **3 s** →
  `SIGKILL`. Jika kill tetap gagal → catat pid, `failed/ZOMBIE_KILL_FAILED`, alert,
  **slot tetap dibebaskan** (jangan blokir pool) — sudah ada di `manager.ts:565-579`.
  Tambah **reap eksplisit** `waitpid(pid, WNOHANG)` setelah SIGKILL agar tidak
  meninggalkan entry `<defunct>` di tabel proses.

---

## 4. Test plan E2E — 2–3 worker paralel

Sudah ada `scripts/e2e/smoke-parallel.mjs` (3 repo independen). Tambah 3 skenario
konflik/merge + determinisme. Semua pakai **mock worker deterministik**
(`OMP_BRIDGE_MOCK=1`) supaya tidak ada live-model call (wajib FASE-1, ADR-002).

### 4.1 Matriks skenario

| # | Skenario | Setup | Ekspektasi (assert) |
|---|---|---|---|
| **P1** | 3 task independen (sudah ada) | repo-a/b/c, file beda | 3 `done`; 3 squash commit di `main` masing-masing; `pool ≤ 3`; `maxInflightMerge == 1` |
| **P2** | **Konflik file** (2 task sentuh file sama) | 1 repo, dua task `files_owned=[lib/math.py]` | Task-2 **ter-defer** (`conflict-deferred`) sampai task-1 merge; setelah release, task-2 jalan; `spawnCount==2` berurutan, bukan paralel. Jika `force:true` → `rejected/CONFLICT_DETECTED` + daftar owner |
| **P3** | **Merge sekuensial** (2 task file beda, 1 repo) | 1 repo, task-A `lib/a.py`, task-B `lib/b.py` | Kedua branch di-merge **satu-per-satu** (`inFlight()==1`); main hijau; verifier pre+post kedua task hijau |
| **P4** | **Verifier merah** pada 1 task | task-B bikin test gagal | task-B `failed/VERIFY_FAILED` **tanpa retry**; task-A tetap merge; main tidak menerima commit merah |
| **P5** | **Determinisme** | Jalankan P1/P3 **N=5 kali** dengan seed & mock sama | `git rev-parse main` (tree-hash akhir) **identik** antar-run; urutan commit squash deterministik |

### 4.2 Assertion kunci (harus ada di harness)

1. `mgr.runningCount() <= maxParallel` **setiap saat** (sampling di pump).
2. `orch.inFlight() <= 1` **setiap saat** — bukti merge tidak pernah paralel.
3. `spawnCount` == jumlah task (tidak ada dobel spawn) — idempotensi.
4. Setelah semua `done`: `git worktree list` == 1 (main saja) — **tidak ada worktree bocor**.
5. `notify_outbox` punya tepat 1 baris per task terminal, `delivered` konsisten.
6. Untuk P5: bandingkan `git rev-parse main^{tree}` antar 5 run → harus sama persis.

### 4.3 Gate determinisme

Mock worker harus **pure function dari spec** (baca `OMP_BRIDGE_SPEC_FILE`, tulis file,
exit). Jangan pakai `Date.now()`/random di konten file yang di-commit — hanya boleh di
nama worktree (yang sudah di-`remove`). Ini yang membuat tree-hash P5 stabil.

---

## 5. Failure mode catalog + recovery behavior

Format: **deteksi → recovery → siapa yang menangani (kode)**.

| # | Failure mode | Deteksi | Recovery yang benar | Kode |
|---|---|---|---|---|
| F1 | **Stale heartbeat** (worker/manager mati diam-diam) | `heartbeat_ts < now - TTL(75s)` saat `start()`/`recoverStale()` | Task running basi → `failed/STALE_HEARTBEAT`; idempoten (restart ke-2 no-op); ownership di-release agar antrean lanjut | `store.staleTasks`, `manager.start/recoverStale` |
| F2 | **Crash mid-task** (orchestrator restart) | Status `running` di DB tanpa proses hidup | Semua state di SQLite → tidak ada task "hilang"; `recoverStale()` bersih­kan; re-dispatch hanya jika `checkLanded` bilang belum landing | EDGE-CASES §5 |
| F3 | **Disconnect voice mid-task** | Sesi LiveKit putus | Task **tetap jalan**; hasil terminal masuk outbox; reconnect → `drainNotify()` tepat-satu-kali | EDGE-CASES §1, `store.drainNotify` |
| F4 | **Worker timeout** | `setTimeout` bridge → `timedOut=true` | **SIGKILL** → cek idempotensi (artifact+verifier) → retry backoff hanya step idempoten → `failed/<CODE> (N attempts)` | `index.runWorker`, `manager.runAttemptLoop` |
| F5 | **Worker exit ≠ 0 / test merah** | `exitCode != 0` | `failed/VERIFY_FAILED` **tanpa retry** (deterministik, non-idempoten); jangan force-merge | `manager.runAttemptLoop` |
| F6 | **Zombie (kill gagal)** | `killWorker()` return false | Catat pid → `failed/ZOMBIE_KILL_FAILED` + alert → **slot dibebaskan** (pool tidak boleh terblokir) → reap `waitpid` | `manager:565-579` |
| F7 | **DB busy** (dua writer) | SQLite `busy`/`locked` | `busy_timeout=5000` → tunggu ≤5 s lalu error jelas `DB_BUSY`, bukan silent-corrupt | `store.ts:140` |
| F8 | **Prompt injection di spec** | `scanSpecForbidden` pre-spawn | Tolak `REPO_NOT_ALLOWED` + alert, task `cancelled`, **spawn counter=0** (tak ada proses); allowlist tetap di-enforce bridge | `manager:312-329`, `safety.ts` |
| F9 | **Dobel delegate** (retry front) | `spawnTask` lihat state | `running`→return running; `done/failed`→terminal; `queued`→tetap 1 entri FIFO. 1 task, 1 spawn | EDGE-CASES §4 |
| F10 | **Push remote ditolak** | `git push` exit ≠ 0 | Retry **3×** backoff **1s/4s/16s** → `failed/PUSH_REJECTED` + instruksi manual; merge lokal tetap di `main-local` | `orchestrator.pushWithRetry` |
| F11 | **Verifier merah saat merge** | verifier pre/post merge gagal | Merge **ditolak**, task `blocked/VERIFY_FAILED`, branch worker dipertahankan untuk inspeksi; tidak pernah `--no-verify` | `orchestrator.reject`, ADR-003 |
| F12 | **Main repo kotor saat merge** | `git status --porcelain` tak kosong | Task `blocked/BLOCKED_GATE MainRepoDirty` — jangan squash di atas working tree kotor | `orchestrator.mergeTaskInner` |
| F13 | **Notifikasi gagal terucap** (sesi putus saat say) | `session.say` throw | **Un-claim** (`delivered=0`) agar ter-drain saat reconnect — jangan hilang | §2.1 langkah 5 (perlu ditambah) |

### 5.1 Prinsip recovery lintas mode

1. **State selalu di store, bukan di sesi** — semua recovery membaca SQLite; tidak
   ada asumsi dari konteks voice atau memori proses.
2. **Single-writer** — hanya manager/orchestrator yang menulis status; worker tidak
   pernah menyentuh DB/main. Ini menghapus kelas race.
3. **Idempoten di batas** — `checkLanded` (artifact+verifier) memastikan re-dispatch
   tidak menggandakan efek; outbox dedupe memastikan notifikasi tidak dobel.
4. **Slot pool tidak boleh terblokir permanen** — zombie/kill-gagal membebaskan slot;
   hanya merge gate yang sah menahan slot.

---

## 6. Ringkasan rekomendasi (cheat-sheet angka)

| Keputusan | Nilai |
|---|---|
| Transport delegasi | **SQLite write + poll** (A). Bukan Hermes WS, bukan CLI-per-delegasi |
| Pickup poll orchestrator | **500 ms** (opsi: write+wakeup SIGUSR1) |
| Notify poll voice | **1.0 s** |
| Claim notifikasi | **atomik** `UPDATE...WHERE delivered=0 RETURNING` |
| Notifikasi proaktif | `allow_interruptions=True`, hormati `notify_gate`, coalesce ≤ 5 |
| Worker | **spawn-on-demand**, `maxParallel` default **2** di VPS (hard-cap 3) |
| Heartbeat interval | **15 s** (ditulis manager) |
| Stale TTL | **75 s** |
| Timeout task coding | **900 s** (keep 300 s untuk mock) |
| Retry | backoff **1 s/4 s**, max **3 attempts**, hanya step idempoten |
| Push retry | **3×**, backoff **1 s/4 s/16 s** |
| Sweep worktree bocor | saat start, hapus `wt-*` > **1 jam** tanpa task running |
| E2E paralel | P1–P5; assert `pool≤maxParallel`, `merge inFlight≤1`, tree-hash deterministik N=5 |
