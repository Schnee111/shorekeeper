# ADR-003: Merge policy — sequential squash + approval gate (FASE 2)

- **Status:** Accepted
- **Tanggal:** 2026-08-17
- **Deciders:** Orkestrator (Shorekeeper) + user
- **Technical Story:** TASK-2.1 — merge orchestrator sebagai pemegang tunggal merge gate

## Context

FASE 1 membuktikan jalur 1 task (delegate → worktree → verifier → merge → done) dengan
merge polos `git merge FETCH_HEAD` di `scripts/e2e/run-pipeline.mjs`. FASE 2 mengorkestrasi
2–3 worker paralel, sehingga pertanyaan merge menjadi kritis:

1. **Siapa yang boleh menulis `main`?** Jika worker (subproses omp/mock) bisa push/commit
   ke main, dua worker yang menyentuh file sama bisa saling menimpa — tanpa deteksi.
2. **Merge paralel vs sequential?** Riset lokal: conflict rate antar agent ~27,67%
   (cross-agent 41,7%). Merge paralel dua task yang menyentuh file sama = konflik merge
   yang mahal (menit), padahal deteksi awal hanya ~ms. False positive > false negative.
3. **Push ke remote kapan?** Remote publik (VPS/GitHub) tidak boleh menerima commit
   tanpa persetujuan manusia — dokumen PRD mensyaratkan approval gate.
4. **Verifier di posisi mana?** Merge gate harus deterministik: hanya menjumlahkan
   commit yang verifier-nya (test suite repo) HIJAU. Bypass `--no-verify` dilarang.

## Decision

1. **Orchestrator = pemegang tunggal merge gate.** Worker (subproses) TIDAK pernah
   push/commit ke main (hard prohibition, PRD + AGENTS.md). Alur per task:
   `kumpulkan artifact → verifier read-only pada branch worker (worktree sementara,
   tidak checkout main) → squash merge ke main → done + merge_commit tercatat`.
   Verifier MERAH → merge DITOLAK, task kembali `blocked` dengan `error="VERIFY_FAILED"`
   (tidak pernah force-merge; branch worker dipertahankan untuk inspeksi manual).
2. **Squash merge, SEQUENTIAL.** Setiap task menghasilkan PERSIS satu commit di main
   (`git merge --squash` + commit `orchestrator(merge): <task_id>`). `mergeTask` dijalankan
   lewat promise-chain (satu-per-satu) — dua task tidak pernah di-merge paralel. Jika
   ada overlap residual (pre-check TASK-2.3 `git merge-tree --name-only` + irisan diff),
   file overlap di-merge file-per-file OLEH ORCHESTRATOR (bukan worker), policy
   "later-wins" untuk file yang disentuh dua sisi.
3. **Approval gate untuk push remote.** Push `main` ke remote HANYA jika flag
   `approval_granted` (env `SHOREKEEPER_APPROVAL_GRANTED=1` / CLI) — default TANPA
   approval = hanya branch lokal `main-local` yang di-update (siap review manusia).
   Push ditolak remote (auth/rebase) → retry 3× backoff (1s/4s/16s) → task `failed`
   dengan `error=PUSH_REJECTED` + instruksi manual; merge lokal tetap ada di main-local.
4. **Verifier read-only** (pola Codex reviewer.toml): test suite repo dijalankan pada
   worktree branch worker SEBELUM merge + dijalankan ULANG pada main SETELAH merge
   (post-merge wajib hijau). Baseline repo selalu hijau sebelum handoff task berikutnya.
5. **merge_commit tercatat tanpa mengubah kontrak Fase 1.** `TaskRecordSchema` LOCKED —
   tidak ada kolom baru. Sha commit (≥ 7 char) ditulis ke `data/artifacts/<task_id>/merge.json`
   (dirujuk store via `artifact_dir`) + disisipkan di akhir `summary` store
   (`Squash merge: <sha7>.`). Kontrak Fase 1 utuh (cross-phase git diff task-store = hanya menambah file).

## Consequences

- **Positif:** main hanya menerima commit AC-hijau; konflik file tidak pernah
  di-merge paralel; push remote butuh persetujuan; deterministik & bisa diaudit
  (merge_commit per task di artifact + summary); worker tetap tidak punya akses tulis
  ke main.
- **Negatif:** throughput merge serial (1 task per waktu) — diterima: merge ~detik,
  worker ~menit; queue FIFO manager menyerap sisanya. Squash kehilangan history
  granular worker — diterima: per-task = 1 commit, narasi di summary; history worker
  detail tetap ada di artifact diff.patch.
- **Risiko dikelola:** verifier mahal (full test suite) dipanggil 2× per merge
  (pre+post) — mitigasi: verifier read-only & idempoten; jika suite lama, E2E memakai
  fixture mini. Push rejected → instruksi manual eksplisit, tidak ada state menggantung.
- **Verifikasi:** unit test orchestrator (2 branch → squash gabungan; verifier merah →
  blocked; approval off/on → remote kosong/terisi; push gagal → failed) + E2E fase 2
  (`bash scripts/gates/gate-fase2.sh`).