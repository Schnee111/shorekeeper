# ADR-005: Event-Driven TaskEventBus & Durable Outbox (Remediation P0-1)

- **Status:** Accepted
- **Tanggal:** 2026-09-04
- **Deciders:** Schnee (User) + Shorekeeper (Agent Orchestrator)
- **Technical Story:** GitHub Issue #4 / Gap Analysis P0-1 (`shorekeeper_architecture_gap_analysis.md`)

## Context

Berdasarkan audit arsitektur independen dan perbandingan dengan OpenAI Realtime, Bodhi Realtime Agent, dan Hermes Live Voice, ditemukan bahwa kelemahan utama sistem Shorekeeper sebelumnya adalah penggunaan polling SQLite di hot-path notifikasi:
```text
worker selesai → update SQLite → tunggu loop sleep 2s → baru terdeteksi → panggil session.say()
```
Polling ini menimbulkan jeda *dead air* 1–2 detik, jitter latensi yang merusak pengalaman suara, serta membebani SQLite sebagai database sekaligus antrean pesan realtime.

## Decision

1. **Membuat Paket `packages/event-bus`:**
   - In-process TypeScript typed event emitter (`TypedEventBus`).
   - Menerapkan schema envelope `TaskEvent` ketat dengan sequence tracking per task untuk mendeteksi missed events.
   - Core event types: `task.accepted`, `task.queued`, `task.started`, `task.progress`, `task.waiting_input`, `task.resumed`, `task.completed`, `task.failed`, `task.cancelled`, `task.unknown`.
2. **Durable Outbox di `packages/task-store`:**
   - Menambahkan tabel `task_outbox` pada SQLite WAL:
     `event_id`, `task_id`, `event_type`, `sequence`, `payload`, `created_at`, `published`, `published_at`.
   - Transaksi commit state task dan pencatatan event outbox bersifat **atomic** dalam satu transaksi database SQLite.
   - Event langsung di-publish ke memory bus (`eventBus.publish()`) seketika saat write terjadi tanpa delay.
   - Menyediakan method `drainOutbox()` untuk rekonsiliasi event yang belum terbit saat terjadi restart/crash.
3. **Pemberitahuan Berbasis Event di `apps/agent`:**
   - Menggantikan loop `while True: await asyncio.sleep(2.0)` dengan `notify_trigger = asyncio.Event()`.
   - Loop notifikasi langsung dibangunkan seketika event tiba, dengan fallback watchdog 5s agar tetap fail-safe.
4. **Prinsip Single VPS / No Distributed Broker:**
   - Sesuai batasan VPS 3.6GB RAM, EventBus diimplementasikan in-process memory pub/sub tanpa perantara Redis/Kafka/NATS.

## Consequences

- **Positif:**
  - Jeda polling 1–2 detik dihilangkan sepenuhnya; event terdistribusi dalam hitungan milidetik.
  - Pemisahan yang jelas antara lapisan state persisten (SQLite) dan lapisan distribusi event (EventBus).
  - Tetap durable dan tahan restart melalui tabel `task_outbox`.
- **Negatif:**
  - Menambah dependensi `event-bus` ke dalam `task-store`.
  - Subscriber harus menangani urutan sequence agar tidak memproses event usang.
- **Verifikasi:**
  - Unit test `packages/event-bus/tests/bus.test.ts` (4 passed).
  - Outbox test `packages/task-store/tests/outbox.test.ts` (2 passed).
  - Full regression `pnpm -r test` (91 passed) & Python agent tests (21 passed).
