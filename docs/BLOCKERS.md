# BLOCKERS — Shorekeeper

Daftar blocker teknis yang sedang aktif. Blocker = tidak bisa dilanjutkan tanpa
keputusan manusia ATAU tanpa workaround yang sudah diverifikasi. Format entri:
ID singkat, tanggal, deskripsi, repro, dampak, workaround.

---

## OMP-001: bin oh-my-pi rusak (packaging) — aktif, workaround MOCK

- **Tanggal:** 2026-08-17
- **Status:** Aktif (workaround diverifikasi: mock worker, lihat ADR-002)
- **Deskripsi:** CLI oh-my-pi yang ter-install global tidak bisa jalan sama sekali —
  dua cacat packaging:
  1. `bin/oh-my-pi.js` meng-import `../src/shared/jsonc-parser.ts` dan
     `../src/config/schema.ts`, tapi direktori `src/` TIDAK ikut di-pack
     (package hanya berisi `dist/`). 
  2. File bin sendiri berisi anotasi TypeScript di file `.js`
     (`function checkFile(path: string, label: string)`), sehingga Node melempar
     `SyntaxError: Unexpected token ':'` bahkan sebelum import dievaluasi.
- **Repro:**
  ```bash
  OMP=/home/daffa/.hermes/node/lib/node_modules/oh-my-pi/bin/oh-my-pi.js
  node "$OMP" version
  # → SyntaxError: Unexpected token ':' (line 176, checkFile(path: string, ...))
  ls /home/daffa/.hermes/node/lib/node_modules/oh-my-pi/src
  # → No such file or directory
  ```
  `node --experimental-strip-types` tidak membantu (type-stripping hanya untuk `.ts`).
  CLI `omp` juga tidak ada di PATH (tidak ada symlink di `~/.hermes/node/bin`).
- **Dampak:** Requirement TASK-1.3 #1 (setup model worker + one-shot `-p "print hello"`)
  dan #2 (spawn `omp` nyata) tidak bisa diverifikasi. `~/.omp/agent/models.yml`
  (routing 9router free `opencode/deepseek-v4-flash-free` via `custom:aeter`)
  sudah benar dan siap dipakai — blocker hanya di binary omp.
- **Workaround (dipakai FASE-1):** bridge berjalan dengan **mock worker**
  deterministik (`OMP_BRIDGE_MOCK=1`, `packages/omp-bridge/src/mock-worker.ts`) —
  menerapkan fix fixture + menjalankan verification_steps. Keputusan dan
  consequences: `docs/adr/0002-omp-transport.md`.
- **Unblock (diperlukan sebelum FASE-2):** reinstall oh-my-pi dari source
  (`git clone https://github.com/can1357/oh-my-pi` + build package yang benar)
  ATAU upstream fix packaging; lalu `node "$OMP" version` hijau dan
  `timeout 10 omp --mode rpc </dev/null` tidak hang. Setelah itu hapus
  `OMP_BRIDGE_MOCK=1` dari scripts E2E → bridge otomatis memakai `omp --mode rpc`.
- **Catatan percobaan (≤2):** 1× repro langsung (`node bin/oh-my-pi.js version`);
  workaround mock dipilih karena kriteria determinisme E2E FASE-1 (fixture frozen,
  no live model call) — bukan keputusan manusia.