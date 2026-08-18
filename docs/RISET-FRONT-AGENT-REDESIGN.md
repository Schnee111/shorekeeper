# RISET: Redesign Front Agent Shorekeeper — Dari "Thin Router Bodoh" ke "Conversational Front"

**Tanggal:** 2026-08-18 · **Status:** Sintesis 6 jalur riset + verifikasi lokal mesin
**Pemicu:** User test front agent → terasa bodoh, pasif, tidak sadar konteks, tidak proaktif, tidak ada follow-up

---

## 0. Diagnosis — Kenapa Agent Terasa Bodoh

Empat akar masalah, semuanya **buatan kita sendiri**, bukan batasan platform:

| # | Akar Masalah | Bukti |
|---|---|---|
| 1 | **Prompt melarang proaktivitas** | FRONT_AGENT.md: "1-3 kalimat per turn, max 1 pertanyaan" + tidak ada instruksi follow-up. USER.md justru minta "proactive, engaging, offers next steps". Kontradiksi langsung. |
| 2 | **Tools mati/dummy** | `delegate_task()` → insert SQLite tanpa konsumen. `consult()` → string hardcoded. `mempalace_search` diklaim di ARCHITECTURE.md tapi tidak ada di kode. Agent "sadar diri" tentang sistem yang tidak ada. |
| 3 | **Nol konteks user** | Prompt janji "personal context pre-fetched" — kode tidak melakukannya. Agent masuk sesi buta: tidak tahu proyek aktif, task berjalan, preferensi user. |
| 4 | **Fitur platform tidak dipakai** | `context_window_compression`, `session_resumption` tidak diaktifkan → sesi mati 10-15 menit, reconnect = amnesia total. |

---

## 1. Temuan Platform (FAKTA-DOK, terverifikasi)

### 1.1 Gemini 3.1 Flash Live — Batasan Keras

| Fakta | Nilai | Sumber |
|---|---|---|
| Context window | 131.072 token input / 65.536 output | ai.google.dev/models |
| Audio token rate | ~25 token/detik | live-api/best-practices |
| Sesi tanpa compression | audio-only **15 mnt**, audio+video **2 mnt** | live-api/session-management |
| Koneksi WS reset | **~10 menit** (GoAway dulu) | live-api/session-management |
| Resumption handle | valid **2 jam** | live-api/session-management |
| Bahasa Indonesia | ✅ native audio out, BCP-47 `id`, auto-switch | live-api/capabilities |
| Harga (di luar free) | $0.005/mnt in + $0.018/mnt out ≈ **$0.023/mnt** | gemini-api/pricing |
| Rate limit free tier | **tidak dipublikasi** — cek AI Studio dashboard | gemini-api/rate-limits |

### 1.2 Yang TIDAK Berfungsi di 3.1 (jangan buang waktu)

| Fitur | Status | Konsekuensi |
|---|---|---|
| `generate_reply()` | ❌ no-op (warning) | Proactive speech HARUS via `session.say()` + TTS |
| `update_instructions()` | ❌ no-op | Persona statis per sesi; ganti = sesi baru |
| `update_chat_ctx()` | ❌ no-op | Tidak bisa inject konteks mid-session via API ini |
| `proactivity=True` | ❌ tidak didukung | Proaktivitas harus dari prompt + outbox push |
| `enable_affective_dialog` | ❌ tidak didukung | — |
| Async tools (WHEN_IDLE) | ❌ sync-only | Model pause menunggu tool → semua tool HARUS <500ms fast-ack |

### 1.3 Bug Kritis Platform — 1007 Storm

Sesi >10 menit: plugin auto-reconnect (resumption ON unconditional), tapi **me-reseed context via `send_client_content`** → ditolak 3.1 (error 1007) → reconnect lagi → loop tak terbatas. **PR fix #6000 masih open per Agustus 2026.**

**Mitigasi wajib:** patch plugin — skip reseed bila resumption handle sudah ada (konteks pulih server-side).

### 1.4 Plugin Terinstall (1.6.10) Sudah Expose

```
RealtimeModel params tersedia (terverifikasi lokal):
  context_window_compression  ← ContextWindowCompressionConfig(trigger_tokens, sliding_window)
  session_resumption          ← SessionResumptionConfig(handle, transparent)
  realtime_input_config       ← automatic_activity_detection, activity_handling, turn_coverage
  thinking_config, media_resolution, input/output_audio_transcription
```

Semua tersedia, **belum satu pun dipakai** di `agent_gemini_live.py`.

---

## 2. Arsitektur Handoff — Keputusan Final (dari riset Task 4, berbasis kode riil)

### 2.1 Transport Delegasi: **SQLite write + poll** ✅

| Opsi | Verdict | Alasan |
|---|---|---|
| SQLite write + poll | **PILIHAN** | Write 0.04ms p50. DB sudah jadi source of truth (state machine, outbox, stale recovery). Fast-ack <500ms margin 10.000×. |
| Hermes WS direct | ❌ | Transport turn LLM — task hilang kalau socket putus, worst-case ack 30s, fd-exhaustion. |
| task-store CLI | ❌ (jalur utama) | ~140ms + 60MB RSS per spawn — buang RAM di VPS 3.6GB. Simpan untuk debug/ops. |

**Tuning:** pickup poll orchestrator 1.0s→**500ms** (opsi SIGUSR1 wakeup), notify poll voice 2.0s→**1.0s**.

### 2.2 Push Completion — Pola Benar

**gate → claim atomik → coalesce → say → rollback-on-failure**

⚠️ **Bug kritis di kode sekarang:** `delivered=1` di-set SEBELUM `session.say`, di luar transaksi → notifikasi hilang permanen kalau user disconnect. Fix: `UPDATE...WHERE delivered=0 RETURNING` (claim), `say`, un-claim kalau gagal.

- User sedang bicara → hormati `notify_gate`, `allow_interruptions=True`
- Multi-task selesai bersamaan → coalesce jadi satu ucapan, ≤5 narasi, urut `created_at ASC`

### 2.3 Worker Daemon: **Spawn-on-demand** (bukan pool)

Budget RAM VPS 3.6GB: baseline ~1.6GB + 2 worker × 400MB = 2.4GB → headroom 1.2GB.

| Parameter | Nilai | Catatan |
|---|---|---|
| maxParallel | **2** (hard-cap 3) | default VPS |
| Heartbeat | **15s** | dari 30s |
| Stale TTL | **75s** | 5× interval |
| Timeout coding task | **900s** | mock tetap 300s |
| Retry | 1s/4s, hanya step idempoten | — |
| Zombie cleanup | SIGTERM→3s→SIGKILL→waitpid | slot tidak boleh terblokir |

### 2.4 oh-my-pi (omp) — Kontrak Nyata

| Aspek | Fakta | Sumber |
|---|---|---|
| RPC mode | NDJSON over stdio, `omp --mode rpc`, korelasi via `id` | docs/rpc.md |
| Completion semantics | `prompt` di-ack segera; selesai = frame `agent_end` dengan `isTerminal` | docs/rpc.md |
| Exit codes | one-shot: 0 sukses / 1 error; RPC: stdin close → exit 0 | print-mode.ts |
| Retry engine built-in | 429/5xx/timeout ✅ retryable; backoff 500ms→8s cap, jitter 75-100%, hormati `retry-after`; fallback chain model; context overflow → auto-compaction (bukan retry) | non-compaction-retry-policy.md |
| RAM per instance | tidak dipublikasi; estimasi 200-400MB (Bun + Rust native addons, model remote) | estimasi arsitektural |
| Python client | paket resmi `omp-rpc` (`RpcClient.prompt_and_wait`) | python/omp-rpc |

**Implikasi:** retry omp default `maxRetries:10, maxDelayMs:300s` → satu job bisa bertahan belasan menit. Timeout worker harus di atas itu, atau turunkan konfigurasi.

---

## 3. Context Engineering — Jawaban "Apa yang Terjadi Bila Penuh"

### 3.1 Perilaku Persis Saat Penuh

`contextWindowCompression(trigger_tokens: 25000, sliding_window: SlidingWindow(target_tokens: 8000))`:
- Saat window > trigger → token tertua **di-evict KERAS (hilang permanen, bukan dirangkum)**
- Model "lupa" percakapan lama tanpa pemberitahuan
- System instructions tetap (di luar window eviction) — tapi konten percakapan hilang

### 3.2 Hierarki Memori (pola MemGPT/virtual context)

| Tier | Isi | Dipegang |
|---|---|---|
| L1 buffer | beberapa turn terakhir | window Live API |
| L2 rolling summary | ringkasan + konteks aktif (1-2k token) | window, diinjeksi backend |
| L3 recall | riwayat sesi penuh | Hermes backend (transkrip) |
| L4 archival | pengetahuan jangka panjang | MemPalace (vector+KG) |

### 3.3 Injeksi Konteks Mid-Session — Satu-satunya Kanal

Karena `update_instructions`/`update_chat_ctx` no-op di 3.1, satu-satunya jalan: **`send_realtime_input(text)`** saat user idle. Ini cocok untuk:
- Rolling summary injection (tiap N turn / saat compression trigger)
- Konteks task selesai
- Re-grounding preferensi

### 3.4 Budget Window 128k (target ≤50% terpakai)

| Komponen | Token |
|---|---|
| Persona (system instructions) | 2-3k |
| Rolling summary | 1-2k |
| Tool schemas | 1.5k |
| Konteks dinamis (task aktif, memori terpilih) | 2k |
| Buffer percakapan (~20-30 turn teks + audio) | sisa |
| **Headroom wajib** | ≥50% (audio 25 tok/detik menumpuk cepat) |

### 3.5 Reconnect Tanpa Amnesia

1. Simpan resumption handle tiap `SessionResumptionUpdate` (overwrite, valid 2 jam)
2. Reconnect proaktif saat GoAway `time_left` < threshold (jangan tunggu putus)
3. Backoff 500ms base, cap 5s, + jitter
4. Setelah reconnect dengan handle → konteks server-side pulih; tanpa handle → seed via initial history + rolling summary terbaru
5. **Patch 1007 storm:** skip `send_client_content` reseed bila handle ada

---

## 4. Prompt Proaktivitas — Template Siap Pakai (dari riset Task 3)

Prinsip lintas-vendor (Vapi, Retell, LiveKit, Google): proaktivitas harus **aturan perilaku eksplisit + contoh kalimat**, bukan kata sifat ("be proactive" diabaikan model).

### Template (±130 kata, tambahan ke prompt yang ada):

```
# Proactivity

After finishing an action, state the result in one sentence, then offer
the single most natural next step as a short optional question — at most
ONE offer per turn.
  Good: "Done — the report is saved. Want me to summarize the key findings?"
  Bad:  "Done. Want a summary? Should I also email it? Maybe check the data?"

- Only suggest follow-ups that directly continue the user's current goal.
- If the user declines or says "that's all", accept immediately. Close
  warmly in one sentence. Offer nothing else.
- If everything is complete and the user is satisfied, a brief statement
  is enough — you do not need to fill silence.
- Match the caller's energy: rushed callers get shorter, faster turns.
- If unsure of an answer, say so — never guess to fill the gap.
```

### Aturan Kapan Proaktif vs Diam

| Proaktif ✅ | Diam ❌ |
|---|---|
| Task baru selesai → tawarkan langkah sekuensial | User menolak / bilang "cukup" |
| Info hilang memblokir tujuan → tanya SATU hal | User terburu-buru |
| Tool return hasil → ringkas + tawaran tindak lanjut | User menginterupsi → stop segera |
| | Task benar-benar tuntas → pernyataan pendek cukup |

### Mitigasi Over-Eager di Prompt Level

1. Hard limit: **maksimal 1 follow-up per turn**, 0 jika user menolak dalam 2 turn terakhir
2. Contoh Bad/Good berpasangan (lebih efektif dari larangan abstrak)
3. Reinforce aturan dari 2-3 sudut berbeda di prompt
4. Budget: blok proaktivitas **~100-200 kata (5-10 baris)** — setiap token = latensi (prompt di-load tiap turn)
5. Banlist panjang = anti-pattern; pakai prinsip positif pendek

---

## 5. Redesign Capability Front Agent

### 5.1 Capability Matrix (target)

| Capability | Tool | Latensi | Status |
|---|---|---|---|
| Ngobrol natural + persona | — (model langsung) | 300-500ms | ✅ sudah ada |
| Web search | `web_search` → SearXNG | <4s (timeout) | ✅ ada, perlu filler UX |
| Waktu/tanggal | `get_current_time` | instant | ✅ |
| Cek task status | `check_task_status` → SQLite | <50ms | ✅ |
| **Memory recall** | `memory_search` → MemPalace (top-k ringkas, ≤800 token) | <500ms | ❌ **baru** |
| **Session context** | pre-fetch saat start (proyek aktif, task berjalan, preferensi) | 0 (startup) | ❌ **baru** |
| Delegate coding | `delegate_task` → SQLite → worker daemon poll → omp | <500ms ack | ⚠️ perlu sambungkan daemon |
| Konsultasi arsitektur | `consult` → Hermes/MemPalace nyata (bukan hardcoded) | <2s | ⚠️ perlu implementasi |
| Push completion | outbox poll 1s → `session.say` | <3s dari selesai | ⚠️ perlu fix bug claim |

### 5.2 Context Injection saat Session Start (BARU)

Sebelum `session.start()`, pre-fetch dan masukkan ke instructions:
1. Identitas user + preferensi kunci (dari MemPalace, ≤300 token)
2. 3-5 task terakhir + status (dari task-store, ≤200 token)
3. Proyek aktif + statusnya (≤200 token)
4. Ringkasan sesi sebelumnya jika ada (≤300 token)

Total injected context: **≤1.000 token** — murah, dampak besar pada "kesadaran".

### 5.3 Rolling Summary (BARU)

Hermes backend merangkum percakapan tiap N=10 turn ATAU saat usage mendekati trigger compression → inject via `send_realtime_input(text="[KONTEKS] ...")` saat user idle. Format: 1-2k token, keputusan + task terbuka + preferensi, tanpa tool output mentah.

---

## 6. Edge Case Checklist (gabungan semua riset)

### Sesi & Koneksi
- [ ] **E1** Context penuh → compression aktif (25k/8k) + rolling summary ter-inject
- [ ] **E2** WS reset 10 menit → resumption handle tersimpan, reconnect proaktif di GoAway
- [ ] **E3** 1007 storm → patch plugin: skip reseed bila handle ada
- [ ] **E4** User disconnect mid-task → task lanjut di worker; reconnect → outbox replay (dedupe per task_id)
- [ ] **E5** Reconnect tanpa handle (handle expired >2 jam) → seed initial history + summary terbaru

### Push Notification
- [ ] **E6** `delivered=1` SETELAH `say` berhasil (bukan sebelum) — bug kritis saat ini
- [ ] **E7** User sedang bicara saat notifikasi masuk → hormati notify_gate, tunggu idle
- [ ] **E8** Multi-task selesai bersamaan → coalesce 1 ucapan ≤5 item, urut created_at
- [ ] **E9** `say` gagal (TTS error) → rollback claim, retry next poll, fallback `generate_reply` (no-op di 3.1, log saja)

### Tools
- [ ] **E10** Tool >500ms (web search) → verbalize dulu ("Biar kucari..."), model pause — filler natural dari model
- [ ] **E11** Tool timeout → narasi error natural ("Pencarian web sedang lambat, mau kucoba lagi?")
- [ ] **E12** Memory search kosong → "Aku belum punya catatan tentang itu" (jangan mengarang)

### Workers
- [ ] **E13** Worker crash mid-task → heartbeat stale 75s → recoverStale → failed/STALE_HEARTBEAT → notifikasi user
- [ ] **E14** Worker timeout 900s → kill (SIGTERM→SIGKILL), reap zombie, slot bebas
- [ ] **E15** 2 task konflik file → task kedua tetap queued sampai pertama done (conflict-map)
- [ ] **E16** omp 429 storm → retry engine internal omp (backoff jittered), maxRetries bisa diturunkan
- [ ] **E17** omp partial output → retry hanya jika belum ada visible output (replay-safe)
- [ ] **E18** Worktree bocor → sweep `wt-*` >1 jam saat daemon start
- [ ] **E19** Verifier merah → no retry, main tidak terima commit merah
- [ ] **E20** Determinisme → N=5 run, `git rev-parse main^{tree}` identik

### Proaktivitas
- [ ] **E21** Agent menawarkan follow-up setelah user menolak 2× → harus 0 penawaran
- [ ] **E22** Agent mengarang status/progress → hard guardrail: hanya baca dari tools
- [ ] **E23** Barge-in saat agent menyampaikan hasil → biarkan interupsi, hasil tetap di outbox "belum dikonfirmasi"

### Keamanan
- [ ] **E24** Injection di task spec (`~/.ssh`, `/etc/passwd`) → scanSpecForbidden pre-spawn (sudah ada Fase 3)
- [ ] **E25** Double delegate (user ulangi perintah) → idempotency per task content hash

---

## 7. Rekomendasi Implementasi (urutan kerja)

### Sprint A — Agent "Waras" (prompt + konteks, ~2-3 jam)
1. **A1** Rewrite `SHOREKEEPER_INSTRUCTIONS`: tambah blok Proactivity (template §4), koreksi aturan brevity (1-3 kalimat untuk jawaban; penawaran follow-up diperbolehkan sebagai kalimat ke-3)
2. **A2** Implementasi context pre-fetch saat session start (§5.2): MemPalace user prefs + task terakhir + proyek aktif → inject ke instructions
3. **A3** Implementasi `memory_search` tool → MemPalace query, top-k ringkas ≤800 token
4. **A4** Fix `consult()` → query MemPalace/Hermes nyata (ganti hardcoded string)

### Sprint B — Sesi Tahan Lama (~2-3 jam)
5. **B1** Aktifkan `context_window_compression` (trigger 25k, retain 8k)
6. **B2** Aktifkan `session_resumption` + simpan handle ke SQLite per room
7. **B3** Patch/mitigasi 1007 storm (skip reseed bila handle ada — patch plugin atau pin fork)
8. **B4** Rolling summary loop di backend → inject `send_realtime_input` saat idle tiap 10 turn

### Sprint C — Jalur Task Nyata (~3-4 jam)
9. **C1** Fix bug outbox claim (E6) — claim atomik, say, rollback
10. **C2** Worker daemon nyata: poll SQLite 500ms → spawn omp (maxParallel=2) → heartbeat 15s
11. **C3** Rebuild omp dari source (unblock OMP-001) + checklist cutover (§2.4)
12. **C4** E2E paralel P2-P5 + determinisme N=5

### Sprint D — Keras (~1-2 jam)
13. **D1** Edge case tests E1-E25 yang bisa diotomasi
14. **D2** Update ARCHITECTURE.md + FRONT_AGENT.md sesuai implementasi final
15. **D3** .env.local cleanup (buang DEEPGRAM/FISH legacy)

---

## 8. Sumber Utama

- Google Live API: session-management, best-practices, capabilities, tools, pricing, rate-limits (ai.google.dev)
- LiveKit Agents docs: sessions, turns, tools, async tools, chat-context, Gemini plugin compat, deployments (docs.livekit.io)
- LiveKit releases: 1.6.0 (async tools), 1.6.9 (tool floor fix) (github.com/livekit/agents)
- Bug 1007 storm: issue #5985, PR #6000 (open) (github.com/livekit/agents)
- Prompt proaktivitas: docs.vapi.ai/prompting-guide, docs.retellai.com/build/prompt-engineering-guide, docs.livekit.io/agents/start/prompting, livekit.com/blog/prompting-voice-agents
- Context engineering: anthropic.com/engineering/effective-context-engineering-for-ai-agents, MemGPT arxiv.org/abs/2310.08560
- oh-my-pi: github.com/can1357/oh-my-pi (README, docs/rpc.md, docs/non-compaction-retry-policy.md, print-mode.ts)
- Riset internal: /mnt/d/riset-context-window-gemini-live.md, /mnt/d/riset-edge-cases-voice-agent.md, /mnt/d/riset-alternatif-front-live-model-2026-08.md
- Handoff design: docs/HANDOFF_DESIGN.md (repo ini)
