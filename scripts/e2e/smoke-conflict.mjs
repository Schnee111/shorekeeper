/**
 * smoke-conflict.mjs — smoke conflict detection (TASK-2.3): 2 task bentrok di
 * lib/math.py (repo-a). Hasil akhir: 1 done dulu (owner), task kedua tetap
 * queued sampai owner selesai lalu jalan + ter-merge SEQUENTIAL — TIDAK ada
 * merge paralel. Log memuat `conflict-detected`.
 *
 * Dipanggil scripts/e2e/smoke-conflict.sh. Exit 0 = sukses.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../../packages/task-store/dist/index.js";
import { WorkerManager } from "../../packages/omp-bridge/dist/index.js";
import { MergeOrchestrator } from "../../packages/merge-orchestrator/dist/index.js";
import { OwnershipMap } from "../../packages/conflict-map/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const VERIFY_CMD = process.env.SHOREKEEPER_VERIFY_CMD ?? "";

function log(msg) {
  console.log(`[smoke-conflict] ${msg}`);
}
function fail(msg) {
  console.error(`[smoke-conflict] FAIL: ${msg}`);
  process.exit(1);
}
function runGit(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!VERIFY_CMD) fail("SHOREKEEPER_VERIFY_CMD wajib di-set");

const DB = arg("--db") ?? join(ROOT, "data", "tasks-conflict.db");
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });
const OWNERSHIP = join(ROOT, "data", "ownership.json");
rmSync(OWNERSHIP, { force: true });

const REPO = join(ROOT, "tests", "fixtures", "repo-a");
const specs = {
  c1: {
    task_id: "c1",
    lane: "debug",
    objective: "fix bug: fungsi add salah return",
    files_owned: ["lib/math.py"],
    requirements: ["add(2,3) harus 5"],
    acceptance_criteria: ["pytest hijau di repo-a"],
    boundaries: ["hanya ubah lib/math.py"],
    verification_steps: [VERIFY_CMD],
  },
  c2: {
    task_id: "c2",
    lane: "frontend",
    objective: "implement feature: tambah fungsi mul (perkalian)",
    files_owned: ["lib/math.py"], // BENTROK dengan c1 — satu file satu owner
    requirements: ["mul(2,3) harus 6"],
    acceptance_criteria: ["pytest hijau di repo-a"],
    boundaries: ["hanya ubah lib/math.py"],
    verification_steps: [VERIFY_CMD],
  },
};

const store = new TaskStore({ dbPath: DB });
const own = new OwnershipMap({
  filePath: OWNERSHIP,
  isActive: (id) => store.getTask(id)?.status === "running",
  onConflict: (a, b, files) => log(`conflict-detected ${a} ${b} files=[${files.join(",")}]`),
});

store.createTask({ task_id: "c1", lane: specs.c1.lane, session_room: "smoke-conflict" });
store.createTask({ task_id: "c2", lane: specs.c2.lane, session_room: "smoke-conflict" });

// --- dekomposisi menulis ownership; klaim kedua BENTROK (tidak overwrite) ---
const claim1 = own.claimFiles("c1", specs.c1.files_owned);
if (claim1.status !== "ok") fail(`claim c1 harus ok: ${JSON.stringify(claim1)}`);
const claim2 = own.claimFiles("c2", specs.c2.files_owned);
if (claim2.status !== "conflict" || !claim2.conflictsWith.includes("c1")) {
  fail(`claim c2 harus conflict dengan c1: ${JSON.stringify(claim2)}`);
}
log(`claim c2 → conflict dengan [${claim2.conflictsWith.join(",")}] (klaim c1 TIDAK di-overwrite)`);

const orch = new MergeOrchestrator({
  store,
  verifierCmd: VERIFY_CMD,
  artifactDirBase: join(ROOT, "data", "artifacts"),
  worktreeBase: join(ROOT, "data", "worktrees", "merge"),
  onTaskClosed: (taskId, status) => {
    if (status === "done" || status === "failed") {
      own.release(taskId);
      mgr.notifyReleased(); // task ter-defer boleh jalan setelah owner ter-merge
    }
  },
});

let maxInflightMerge = 0;
let curInflight = 0;
const mergeOrder = [];
const mgr = new WorkerManager({
  store,
  allowlist: [REPO],
  artifactDirBase: join(ROOT, "data", "artifacts"),
  mockMarkerDir: join(ROOT, "data", "spawns"),
  ownership: own,
  mock: true,
  onWorkerReady: async (taskId) => {
    curInflight += 1;
    maxInflightMerge = Math.max(maxInflightMerge, curInflight);
    try {
      const r = await orch.mergeTask(taskId, REPO);
      mergeOrder.push(taskId);
      log(`merge ${taskId} → ${r.status}${r.mergeCommit ? ` (${r.mergeCommit.slice(0, 7)})` : ""}`);
      if (r.status !== "merged" && r.status !== "empty") fail(`merge ${taskId} ditolak: ${r.status} ${r.reason ?? ""}`);
    } finally {
      curInflight -= 1;
    }
  },
  onTaskTerminal: (taskId, status) => {
    // done: release oleh orchestrator (onTaskClosed) — jangan ganda.
    if (status === "failed") own.release(taskId);
  },
  onEvent: (e) => {
    if (["dispatch", "worker-ok", "terminal", "conflict-deferred", "slot-freed"].includes(e.type)) {
      const detail = e.owners ? ` owners=[${e.owners.join(",")}]` : e.reason ? ` — ${e.reason}` : "";
      log(`evt ${e.type} ${e.taskId}${detail}`);
    }
  },
});

await mgr.start();
await mgr.spawnTask("c1", REPO, { spec: specs.c1, mock: true });
await mgr.spawnTask("c2", REPO, { spec: specs.c2, mock: true });

// --- bukti pre-spawn: c2 tetap queued saat c1 running ---
if (mgr.queuedCount() !== 1 || !mgr.peekQueued().includes("c2")) {
  fail(`c2 harus tetap queued (queuedCount=${mgr.queuedCount()}, queued=[${mgr.peekQueued().join(",")}])`);
}
log("pre-spawn OK: c2 tetap queued menunggu owner c1 selesai");
await mgr.drain();
mgr.stop();

// --- end-state: keduanya done, SEQUENTIAL (c1 dulu), tanpa merge paralel ---
if (store.getTask("c1").status !== "done") fail(`c1 status=${store.getTask("c1").status} (harusnya done)`);
if (store.getTask("c2").status !== "done") fail(`c2 status=${store.getTask("c2").status} (harusnya done)`);
if (maxInflightMerge > 1) fail(`merge paralel terdeteksi: maxInflightMerge=${maxInflightMerge}`);
if (!(mergeOrder[0] === "c1" && mergeOrder[1] === "c2")) {
  fail(`urutan merge salah: [${mergeOrder.join(",")}] (harus c1,c2 sequential)`);
}
const count = runGit(REPO, ["rev-list", "--count", "HEAD"]);
if (count !== "3") fail(`repo-a commit main=${count} (harusnya 3: initial + 2 squash sequential)`);
const branches = runGit(REPO, ["branch", "--list", "worker/*"]);
if (branches.trim() !== "") fail(`branch worker tersisa: ${branches}`);

// --- bukti deteksi: log + counter ownership.json ---
if (own.conflictCount() < 1) fail("counter conflict_detected < 1");
const lines = own.conflictLog();
if (!lines.some((l) => l.startsWith("conflict-detected"))) fail("log ownership tidak memuat conflict-detected");
log(`deteksi tercatat: ${lines.join(" | ")}`);
store.close();
log("SMOKE-CONFLICT: PASS — 1 done + 1 menunggu (queued), lalu sequential merge, conflict-detected ≥ 1");
