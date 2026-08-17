# DEPLOYMENT.md — Shorekeeper (TASK-3.4)

Executable guide: WSL lokal (dev/staging) → VPS `ubuntu@43.133.136.244`.
Hard rule: **GRATIS** (nol langganan); LiveKit Cloud **free tier** dengan cap.

> Stop condition fase ini: deploy aktual ke VPS membutuhkan akses user —
> dokumen ini menyiapkan semuanya; eksekusi VPS oleh user.

---

## 1. Prasyarat

| Item | Nilai | Catatan |
|---|---|---|
| Node.js | ≥ 22.18 | `node --version` |
| pnpm | ≥ 9 | `pnpm --version` |
| uv + Python | ≥ 3.10 | `uv --version` (apps/agent) |
| git | any | worker isolation pakai worktree |
| docker + compose | v2 | stack observability (TASK-3.1) |
| RAM | ≥ 4 GB (VPS 3.6 GB KETAT) | tabel budget di bawah |
| Disk | ≥ 14 GB free | Prometheus retention 2d (compose) |

**Budget RAM VPS (3.6 GB) — jangan melebihi:**

| Komponen | RAM | Mode |
|---|---|---|
| Hermes orchestrator | ~480 MB | daemon |
| Postgres (jika dipakai luar Shorekeeper) | ~260 MB | daemon |
| Shorekeeper (node manager+store) | ~300 MB | on-demand |
| omp worker | ~200–400 MB | **on-demand, JANGAN daemon** |
| front live (LiveKit agent) | ~300–500 MB | daemon |
| OTel stack (collector+jaeger+prometheus) | ~250–350 MB | daemon (compose) |

**OpenHands TIDAK muat** di VPS ini — jangan dipasang.

**Port yang dipakai (deteksi bentrok ada di `scripts/otel/up.sh`):**
`4318` OTLP/HTTP, `16686` Jaeger UI, `9090` Prometheus, `4317` OTLP gRPC,
`13133` collector health, `9119` Hermes WS.

**LiveKit Cloud free tier:** 5.000 participant-menit + 1.000 agent-menit/bulan,
**hard cap** — saat kuota habis, sesi BARU GAGAL dibuat (tidak ada overage
billing). Pantau usage di dashboard LiveKit.

## 2. Deploy WSL (dev/staging) — command persis

```bash
# 1) clone/ambil monorepo
cd ~/projects
git clone <repo> shorekeeper && cd shorekeeper   # atau rsync dari mesin dev

# 2) install + build
pnpm install                                     # expected: "Done in Xs"
pnpm -r build                                    # expected: semua "Done", exit 0
uv sync --project apps/agent                     # expected: resolved deps Python

# 3) env
cp .env.example .env                             # isi manual (JANGAN commit)

# 4) stack observability (dibutuhkan gate + smoke)
bash scripts/otel/up.sh
# expected: "[otel-up] stack observability NAIK" + 3 healthcheck hijau

# 5) quality gate penuh: regresi fase 1-2 + golden ≥85% + smoke produksi
bash scripts/gates/gate-fase3.sh                 # expected: GATE-FASE3: PASS, exit 0
# (gate memanggil scripts/e2e/smoke-prod.sh di dalamnya — smoke terpisah hanya
#  bila perlu debugging cepat: bash scripts/e2e/smoke-prod.sh)
```

## 3. Deploy VPS (rsync/git + systemd)

```bash
# di mesin dev (dari root monorepo):
rsync -az --delete \
  --exclude node_modules --exclude data --exclude scripts/e2e/logs \
  ~/projects/shorekeeper/ ubuntu@43.133.136.244:/opt/shorekeeper/

# di VPS:
ssh ubuntu@43.133.136.244
cd /opt/shorekeeper
pnpm install && pnpm -r build
uv sync --project apps/agent
cp .env.example .env && nano .env        # isi LIVEKIT_*/GEMINI_API_KEY manual

# pasang unit systemd (sudah disiapkan di deploy/systemd/):
sudo cp deploy/systemd/shorekeeper-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shorekeeper-otel.service
sudo systemctl enable --now shorekeeper-orchestrator.service
sudo systemctl enable --now shorekeeper-agent.service   # fase voice

# verifikasi (expected output di samping tiap perintah):
systemctl is-active shorekeeper-otel shorekeeper-orchestrator   # active  active
curl -sf localhost:9090/-/healthy && echo OK                    # OK
curl -sf localhost:16686/api/services | head -c 80              # {"data":...
bash scripts/e2e/smoke-prod.sh                                  # SMOKE-PROD: PASS
```

**omp on-demand (BUKAN daemon)** — jalankan hanya saat task:

```bash
# start (oleh manager saat dispatch — jangan systemd-kan)
omp --mode rpc            # hidup hanya selama 1 task, lalu exit
# stop: proses selesai sendiri; bila hang, manager kill SIGKILL via timeout.
```

## 4. Checklist verifikasi produksi

- [ ] `bash scripts/gates/gate-fase3.sh` exit 0 (GATE-FASE3: PASS)
- [ ] `bash scripts/e2e/smoke-prod.sh` exit 0 (trace id di Jaeger, store 1 done)
- [ ] `curl -s localhost:9090/api/v1/query?query=task_done_total` ≥ 1
- [ ] `curl -s localhost:16686/api/services` memuat `shorekeeper-orchestrator`
- [ ] backup pertama dibuat: `bash scripts/ops/backup-db.sh` → `data/backups/tasks-*.db`
- [ ] uji restore sukses (lihat §6) — rollback TERUJI sebelum traffic nyata

## 5. Monitoring ringkas

- Trace: `http://<host>:16686` → service `shorekeeper-orchestrator`
  (span `task.run → delegate_task → worker.run → merge`).
- Metrics: `http://<host>:9090` → `task_done_total`, `task_failed_total`,
  `worker_duration_seconds`, `merge_duration_seconds`, `worker_pool_size`,
  `conflict_detected_total`.
- Log unit: `journalctl -u shorekeeper-orchestrator -f`

## 6. Backup / restore + RTO/RPO

```bash
bash scripts/ops/backup-db.sh                # backup online (db.backup SQLite)
bash scripts/ops/restore-db.sh [PATH_BACKUP] # default: backup terbaru
```

- **RPO** ≈ interval backup (backup = snapshot saat dipanggil; jadwalkan cron,
  mis. tiap 1 jam → RPO ≤ 1 jam; task store single-file = kecil).
- **RTO** ≈ waktu restore + restart unit (< 1 menit: `restore-db.sh` +
  `systemctl restart shorekeeper-orchestrator`).

## 7. Rollback (mode shadow/HITL)

1. `sudo systemctl stop shorekeeper-agent shorekeeper-orchestrator`
2. `bash scripts/ops/restore-db.sh data/backups/tasks-<ts>.db`
3. `sudo systemctl start shorekeeper-orchestrator shorekeeper-agent`
4. Verifikasi: `bash scripts/e2e/smoke-prod.sh` → `SMOKE-PROD: PASS`

Rollback satu-file DB (SQLite) + `systemctl revert` unit = prosedur di atas.
**Uji restore WAJIB sebelum traffic nyata** (jangan tulis prosedur yang belum
terbukti — sudah diuji gate: `tests` + smoke §4).

## 8. Error cases yang ditangani skrip

| Kasus | Perilaku |
|---|---|
| port sudah dipakai | `scripts/otel/up.sh` lapor port + proses pemakai, TIDAK paksa bind (exit 1) |
| docker daemon mati | pesan eksplisit (`systemctl start docker`), exit 1 |
| service down saat smoke | `smoke-prod.sh` exit non-0 + print status ringkas (compose ps / systemctl) |
| backup korup | `backup-db.sh` hapus hasil, exit 1 |
| restore dari backup rusak | `restore-db.sh` TIDAK menyentuh DB hidup, exit 1 |
| kolektor OTel mati | orkestrasi fail-open (warning log), tidak menghentikan task |
