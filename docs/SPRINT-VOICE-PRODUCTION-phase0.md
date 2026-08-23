# PHASE 0 — FIX OMP BUILD (unblock OMP-001)

Status: [~] Blocked · Prioritas: P0

### Task 0.1: Rebuild oh-my-pi dari source  
[ ] Clone: `git clone https://github.com/can1357/oh-my-pi ~/projects/oh-my-pi-build`

**STATUS:** Repository cloned but build not feasible on WSL. Proceeding with mock worker per ADR-002.

- [ ] Cek toolchain: `bun --version` (jika belum ada: `curl -fsSL https://bun.sh/install | bash`)
- [ ] Build: `cd ~/projects/oh-my-pi-build && bun install && bun run build`
      (baca README/AGENTS.md repo untuk perintah build yang benar; native Rust addon butuh
      `libstdc++`/toolchain — install via apt jika kurang)
- [ ] Pack & install global: `npm pack` → `npm uninstall -g oh-my-pi` →
      `npm install -g oh-my-pi-*.tgz` (atau sesuaikan nama package hasil build)

### Task 0.2: Verifikasi binary  
[ ] `omp version` ATAU `node $(npm root -g)/oh-my-pi/bin/oh-my-pi.js version` → exit 0, tanpa SyntaxError  
[ ] `timeout 10 omp --mode rpc </dev/null` → tidak hang, exit 0  

**BLOCKED:** All OMP binaries fail with runtime errors. Continuing with MOCK worker (OMP_BRIDGE_MOCK=1) per ADR-002.

---
