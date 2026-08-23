/**
 * smoke-parallel.mjs — smoke worker manager (TASK-2.2 CLU): 3 task independen
 * kecil paralel (repo-a/b/c) lewat WorkerManager (pool ≤ 3) + merge gate
 * orchestrator (sequential). Bukti: 3 done, 3 squash commit di main masing-
 * masing, pool tidak pernah > 3, tidak ada merge paralel.
 *
 * Dipanggil scripts/e2e/smoke-parallel.sh. Exit 0 = sukses.
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
  console.log(`[smoke-parallel] ${msg}`);
}
function fail(msg) {
  console.error(`[smoke-parallel] FAIL: ${msg}`);
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

const DB = arg("--db") ?? join(ROOT, "data", "tasks-parallel.db");
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });
const OWNERSHIP = join(ROOT, "data", "ownership.json");
rmSync(OWNERSHIP, { force: true });

const repos = {
  p1: join(ROOT, "tests", "fixtures", "repo-a"),
  p2: join(ROOT, "tests", "fixtures", "repo-b"),
  p3: join(ROOT, "tests", "fixtures", "repo-c"),
};
const specs = {
  p1: {
    task_id: "p1",
    lane: "debug",
    objective: "fix bug: fungsi add salah return",
    files_owned: ["lib/math.py"],
    requirements: ["add(2,3) harus 5"],
    acceptance_criteria: ["pytest hijau di repo-a"],
    boundaries: ["hanya ubah lib/math.py"],
    verification_steps: [VERIFY_CMD],
  },
  p2: {
    task_id: "p2",
    lane: "frontend",
    objective: "implement feature: fungsi double belum ada isinya",
    files_owned: ["lib/feature.py"],
    requirements: ["double(21) harus 42"],
    acceptance_criteria: ["pytest hijau di repo-b"],
    boundaries: ["hanya ubah lib/feature.py"],
    verification_steps: [VERIFY_CMD],
  },
  p3: {
    task_id: "p3",
    lane: "qa",
    objective: "fix typo: sapaan greet salah eja",
    files_owned: ["lib/greet.py"],
    requirements: ["greet() harus 'Hello, world'"],
    acceptance_criteria: ["pytest hijau di repo-c"],
    boundaries: ["hanya ubah lib/greet.py"],
    verification_steps: [VERIFY_CMD],
  },
};

const store = new TaskStore({ dbPath: DB });
const own = new OwnershipMap({
  filePath: OWNERSHIP,
  isActive: (id) => store.getTask(id)?.status === "running",
  onConflict: (a, b, files) => log(`conflict-detected ${a} ${b} files=[${files.join(",")}]`),
});
for (const id of Object.keys(specs)) {
  store.createTask({ task_id: id, lane: specs[id].lane, session_room: "smoke-parallel" });
  const claim = own.claimFiles(id, specs[id].files_owned);
  if (claim.status !== "ok") fail(`claim ${id} bentrok: ${JSON.stringify(claim)}`);
}

const orch = new MergeOrchestrator({
  store,
  verifierCmd: VERIFY_CMD,
  artifactDirBase: join(ROOT, "data", "artifacts"),
  worktreeBase: join(ROOT, "data", "worktrees", "merge"),
  onTaskClosed: (taskId, status) => {
    if (status === "done" || status === "failed") {
      own.release(taskId);
      mgr.notifyReleased();
    }
  },
});

let maxInflightMerge = 0;
let curInflight = 0;
const mgr = new WorkerManager({
  store,
  allowlist: Object.values(repos),
  artifactDirBase: join(ROOT, "data", "artifacts"),
  mockMarkerDir: join(ROOT, "data", "spawns"),
  ownership: own,
  mock: true,
  onWorkerReady: async (taskId) => {
    curInflight += 1;
    maxInflightMerge = Math.max(maxInflightMerge, curInflight);
    try {
      const r = await orch.mergeTask(taskId, repos[taskId]);
      log(`merge ${taskId} → ${r.status}${r.mergeCommit ? ` (${r.mergeCommit.slice(0, 7)})` : ""}`);
      if (r.status !== "merged" && r.status !== "empty") fail(`merge ${taskId} ditolak: ${r.status} ${r.reason ?? ""}`);
    } finally {
      curInflight -= 1;
    }
  },
  onTaskTerminal: (taskId, status) => {
    // done: release dilakukan orchestrator SEBELUM transisi done (onTaskClosed) —
    // jangan release ganda. failed tanpa merge: release agar antrean ter-defer jalan.
    if (status === "failed") own.release(taskId);
  },
  onEvent: (e) => {
    if (["dispatch", "worker-ok", "terminal", "conflict-deferred", "slot-freed"].includes(e.type)) {
      log(`evt ${e.type} ${e.taskId}${e.reason ? ` — ${e.reason}` : ""}`);
    }
  },
});

await mgr.start();
const t0 = Date.now();
for (const id of Object.keys(specs)) {
  const r = await mgr.spawnTask(id, repos[id], { spec: specs[id], mock: true });
  log(`spawn ${id} → ${r.status}`);
}

// observasi pool: tidak pernah > 3 running
let maxRunning = 0;
const poll = setInterval(() => {
  maxRunning = Math.max(maxRunning, mgr.runningCount());
}, 25);
await mgr.drain();
clearInterval(poll);
mgr.stop();

if (maxRunning > 3) fail(`pool melebihi hard cap: maxRunning=${maxRunning}`);
log(`pool max running=${maxRunning} (cap 3) — durasi ${(Date.now() - t0) / 1000}s`);
if (maxInflightMerge > 1) fail(`merge paralel terdeteksi: maxInflightMerge=${maxInflightMerge}`);

// --- end-state: 3 done + 3 squash commit + tidak ada sisa branch/worktree ---
for (const id of Object.keys(specs)) {
  const rec = store.getTask(id);
  if (rec.status !== "done") fail(`task ${id} status=${rec.status} (harusnya done), error=${rec.error}`);
  const repo = repos[id];
  const count = runGit(repo, ["rev-list", "--count", "HEAD"]);
  if (count !== "2") fail(`repo ${id}: commit main=${count} (harusnya 2: initial + squash)`);
  const branches = runGit(repo, ["branch", "--list", "worker/*"]);
  if (branches.trim() !== "") fail(`repo ${id}: branch worker tersisa: ${branches}`);
  runGit(repo, ["worktree", "prune"]);
  const wt = runGit(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
  if (wt.length !== 1) fail(`repo ${id}: worktree tersisa: ${wt.join(", ")}`);
  log(`repo ${id}: 2 commit main, bersih (branch/worktree)`);
}
store.close();
log("SMOKE-PARALLEL: PASS — 3 task independen paralel (≤3), semua done, merge sequential");
