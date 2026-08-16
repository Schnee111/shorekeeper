# API.md — Shorekeeper: Kontrak & Tool Surface

| | |
|---|---|
| **Status** | Draft v1 (FASE 1) |
| **Tanggal** | 2026-08-17 |
| **Pemegang** | Orkestrator (Hermes) |
| **Terkait** | `packages/contracts` (implementasi zod), `docs/ARCHITECTURE.md` |

Dokumen ini adalah **source of truth** untuk kontrak data & tool. Implementasi zod di
`packages/contracts/src/contracts.ts` harus mengikuti dokumen ini; jika keduanya berbeda,
dokumen menang — tulis ulang implementasi.

---

## 1. Overview

Aliran data utama (FASE 1):

```
front (voice) --handoff JSON--> orchestrator (Hermes) --task spec--> worker (worktree)
      ^                                                            |
      └------------------- check_task_status <-- task store <------┘
```

- **Handoff contract** (§2.1): front → orchestrator, apa yang user minta.
- **Task record** (§2.2): state task di task store SQLite (persisten).
- **Task spec** (§2.3): orchestrator → worker, contract-first decomposition.
- **Tools** (§3): surface tool yang dipakai Hermes/orchestrator.

## 2. Handoff contract

### 2.1 Handoff (front → orchestrator)

JSON strict — `HandoffSchema` (zod, `packages/contracts`):

```json
{
  "intent": "kerjakan issue #12 di repo X",
  "entities": [
    { "type": "repo", "value": "repo-a" },
    { "type": "issue", "value": "#12" }
  ],
  "transcript_ref": "room_abc/2026-08-17T04:00:00Z",
  "confidence": 0.92,
  "language": "id"
}
```

| Field | Tipe | Wajib | Aturan |
|---|---|---|---|
| `intent` | string | ✅ | 1 kalimat, minimal 1 karakter |
| `entities` | `[{type, value}]` | ❌ | default `[]`; type/value min 1 char |
| `transcript_ref` | string | ✅ | room + timestamp (audit) |
| `confidence` | number | ✅ | 0..1 |
| `language` | string | ❌ | default `"id"`, 2–8 char |

**Contoh INVALID** (harus di-reject dengan pesan field):

```json
{ "entities": [], "transcript_ref": "r/1", "confidence": 0.9 }
<!-- reject: "intent wajib diisi (tidak boleh kosong)" -->

{ "intent": "kerjakan issue #12", "transcript_ref": "r/1", "confidence": "high" }
<!-- reject: confidence harus number 0..1 (field "confidence") -->
```

**Aturan versioning (breaking change → bump, jangan ubah in-place):**

- `CONTRACT_VERSION` di `packages/contracts` naik 1 angka penuh tiap field baru/hapus/ubah
  semantik. Versi lama tetap bisa di-parse (toleran: field baru default, field hapus diabaikan).
- Konsumen yang memakai versi lama mendapat peringatan di log, bukan crash.
- Contoh: menambah field `expected_outcome` = minor (default null, version tetap 1 jika
  opsional dengan default); mengubah `confidence` dari 0..1 ke 0..100 = MAJOR (bump ke 2).

### 2.2 Task record (task store)

Record persisten di SQLite (WAL) — `TaskRecordSchema`. Semua timestamp = epoch ms.

```json
{
  "task_id": "task_de_01",
  "session_room": "shore-room",
  "user_intent": "perbaiki bug login",
  "parent_id": null,
  "lane": "debug",
  "status": "running",
  "worker_pid": 12345,
  "heartbeat_ts": 1724000000000,
  "created_at": 1723999000000,
  "started_at": 1723999100000,
  "finished_at": null,
  "contract_ref": "plans/task_de_01.md",
  "artifact_dir": "data/artifacts/task_de_01",
  "summary": "",
  "error": null,
  "notify_gate": "next_turn",
  "priority": 1
}
```

**State machine (locked):**

```
queued → running → done | failed | cancelled
running → blocked → running | cancelled | failed
```

Transisi lain (mis. `done → running`) → error `INVALID_TRANSITION`, jangan silent-allow.
Catatan: heartbeat_ts = liveness worker; stale → `failed` + `error="STALE_HEARTBEAT"`.

Kontrak voice: `summary` ≤ 200 kata → enforce di layer API (store), bukan DB.

### 2.3 Task spec (orchestrator → worker)

Contract-first decomposition — `TaskSpecSchema` (zod, strict):

```json
{
  "task_id": "task_de_01",
  "lane": "debug",
  "objective": "fix bug: fungsi add salah return",
  "files_owned": ["lib/math.py", "tests/test_math.py"],
  "requirements": ["input angka -> output jumlah yang benar"],
  "acceptance_criteria": ["pytest hijau"],
  "boundaries": ["jangan sentuh file di luar lib/ dan tests/"],
  "verification_steps": ["uv run pytest -q"]
}
```

## 3. Tools (Hermes / orchestrator)

### 3.1 `omp_spawn_worker(task_spec, repo_path, timeout_seconds)`

- **Purpose:** mendelegasikan 1 task coding ke worker (oh-my-pi) di worktree terisolasi.
  Dipakai ketika handoff menghasilkan task yang membutuhkan edit file — **bukan** untuk
  pertanyaan faktual (pakai `consult`).
- **Side effect:** spawn proses worker (reversible: kill saat timeout). **Approval: no.**
- **Result:** `{ exitCode, stdoutTail, diffSummary }`.
- **Errors:** `TIMEOUT` (kill proses, tidak hang), `REPO_NOT_ALLOWED` (repo di luar allowlist —
  ditolak TANPA spawn), `INVALID_SPEC` (task spec gagal zod).
- **Interpretasi hasil:** `exitCode=0` + test hijau = sukses; test merah = `VERIFY_FAILED`,
  bukan sukses. Worker timeout ≠ gagal — cek side effect (file/diff) sebelum re-dispatch.

### 3.2 `check_task_status(task_ids | "active")`

- **Purpose:** pull status untuk voice. Output ≤ 5 baris `narratable[]` + `counts`
  (zero hallucination — semua angka dari store). Task tak dikenal:
  `{ "taskId": { "status": "not_found" } }` — jangan throw.
- **Side effect:** none. **Approval:** no.

### 3.3 `delegate_task(task_description, lane)` (front → orchestrator, FASE 2 penuh)

- **Purpose:** fast-ack enqueue task dari front, ack < 500ms.
- **Side effect:** tulis task store (single-writer = orchestrator). **Approval:** no.

### 3.4 `merge_worker_output(task_id, commit_msg)` (FASE 2)

- **Purpose:** merge gate: ambil artifact worker → verifier → squash merge sequential ke main.
- **Side effect:** tulis branch main lokal. **Approval: YES** untuk push remote.
- Implementasi: `packages/merge-orchestrator` (`MergeOrchestrator.mergeTask`) — pemegang
  tunggal merge gate; worker tidak pernah push/commit ke main (hard prohibition).
  Kebijakan: `docs/adr/0003-merge-policy.md`.
- **merge_commit** (sha ≥ 7 char) tercatat di `data/artifacts/<task_id>/merge.json`
  (dirujuk store via `artifact_dir`) + disisipkan di akhir `summary` store
  (`Squash merge: <sha7>.`) — kontrak Fase 1 (TaskRecordSchema) tidak diubah.
- **Approval push:** env `SHOREKEEPER_APPROVAL_GRANTED=1` (+ opsional
  `SHOREKEEPER_REMOTE_URL` untuk origin) → push `main` ke remote dengan retry 3×
  backoff; gagal → task `failed` (`PUSH_REJECTED`) + instruksi manual. Tanpa approval
  → hanya branch lokal `main-local` yang di-update (default).
- **Verifier merah** → merge ditolak, task kembali `blocked` dengan
  `error="VERIFY_FAILED"` (tidak pernah force-merge / `--no-verify`).

### 3.5 CLI `task-store` (debug manual + dipakai E2E)

```
task-store new --lane debug --intent "..."              # buat task queued
task-store status <task_id>                             # lihat record
task-store done <task_id> --summary "..."               # transisi running->done
task-store fail <task_id> --error "..."                 # transisi ->failed
task-store list [--status running]                      # daftar task
```

DB default `data/tasks.db` (override `TASKS_DB` env). WAL mode + busy_timeout 5000ms.

## 4. Versioning & kompatibilitas

- Kontrak json: maju-satu-arah — konsumen tahu `CONTRACT_VERSION` yang dipakai, log warning
  saat mismatch.
- Tool surface: nama tool & skema argumen stabil; perubahan = tambah tool baru, jangan ubah
  argumen tool lama (pola API.md: versioned, jangan ubah in-place).
- ADR yang relevan: `docs/adr/0001-layout-monorepo.md`, `docs/adr/0002-omp-transport.md`.