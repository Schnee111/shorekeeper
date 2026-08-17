/**
 * run-fase2.mjs — driver E2E FASE-2 (TASK-2.4): 2–3 task paralel + konflik +
 * gagal berulang, deterministik (fixture frozen, model free via mock, timeout
 * ketat). Satu DB + satu ownership.json untuk SEMUA skenario (fresh per run).
 *
 * Skenario A (paralel bersih): 3 task independen (repo-a/b/c) → ≤3 running,
 *   semua done, 3 squash commit di main masing-masing, tanpa cascade failure.
 * Skenario B (konflik): 2 task bentrok lib/math.py (repo-a) → deteksi
 *   ownership → task kedua queued sampai pertama done → merge sequential,
 *   log `conflict-detected`, TANPA merge paralel.
 * Skenario C (gagal berulang): 1 task timeout terus (step idempoten) →
 *   retry 2× backoff → failed + error jelas; task lain tidak terpengaruh.
 *
 * Dipanggil scripts/e2e/run-fase2.sh. Exit 0 hanya jika SEMUA skenario benar.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
  console.log(`[e2e-fase2][${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
function fail(stage, msg) {
  log(`FAILED stage=${stage}: ${msg}`);
  process.exit(1);
}
function runGit(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!VERIFY_CMD) fail("env", "SHOREKEEPER_VERIFY_CMD wajib di-set");

const DB = arg("--db") ?? join(ROOT, "data", "tasks-fase2.db");
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });
const OWNERSHIP = join(ROOT, "data", "ownership.json");
rmSync(OWNERSHIP, { force: true });
const ARTIFACTS = join(ROOT, "data", "artifacts");
const REPO_A = join(ROOT, "tests", "fixtures", "repo-a");
const REPO_B = join(ROOT, "tests", "fixtures", "repo-b");
const REPO_C = join(ROOT, "tests", "fixtures", "repo-c");

const store = new TaskStore({ dbPath: DB });
const own = new OwnershipMap({
  filePath: OWNERSHIP,
  isActive: (id) => store.getTask(id)?.status === "running",
  onConflict: (a, b, files) => log(`conflict-detected ${a} ${b} files=[${files.join(",")}]`),
});

const orch = new MergeOrchestrator({
  store,
  verifierCmd: VERIFY_CMD,
  artifactDirBase: ARTIFACTS,
  worktreeBase: join(ROOT, "data", "worktrees", "merge"),
  onTaskClosed: (taskId, status) => {
    if (status === "done" || status === "failed") {
      own.release(taskId);
      if (mgrRef) mgrRef.notifyReleased(); // task ter-defer jalan setelah owner ter-merge
    }
  },
});

// --- metrik observasi (assertion: tanpa paralelisme berlebihan) ---
let maxRunning = 0;
let maxInflightMerge = 0;
let curInflightMerge = 0;
const mergeOrder = [];
let mgrRef = null;
const poll = setInterval(() => {
  maxRunning = Math.max(maxRunning, mgrRef ? mgrRef.runningCount() : 0);
}, 20);

const mgr = new WorkerManager({
  store,
  allowlist: [REPO_A, REPO_B, REPO_C],
  artifactDirBase: ARTIFACTS,
  mockMarkerDir: join(ROOT, "data", "spawns"),
  ownership: own,
  mock: true,
  heartbeatIntervalMs: 5000,
  onWorkerReady: async (taskId) => {
    curInflightMerge += 1;
    maxInflightMerge = Math.max(maxInflightMerge, curInflightMerge);
    const repo = taskRepo[taskId];
    try {
      const r = await orch.mergeTask(taskId, repo);
      mergeOrder.push(taskId);
      log(`merge ${taskId} → ${r.status}${r.mergeCommit ? ` (${r.mergeCommit.slice(0, 7)})` : ""}`);
      if (r.status !== "merged" && r.status !== "empty") {
        fail("merge", `merge ${taskId} ditolak: ${r.status} ${r.reason ?? ""}`);
      }
    } finally {
      curInflightMerge -= 1;
    }
  },
  onTaskTerminal: (taskId, status) => {
    // done: release oleh orchestrator (onTaskClosed) — jangan ganda.
    // failed tanpa merge (skenario C): release agar antrean ter-defer jalan.
    if (status === "failed") own.release(taskId);
  },
  onEvent: (e) => {
    if (["dispatch", "worker-ok", "terminal", "conflict-deferred", "retry", "timeout"].includes(e.type)) {
      const detail = e.owners ? ` owners=[${e.owners.join(",")}]` : e.reason ? ` — ${e.reason.slice(0, 80)}` : "";
      log(`evt ${e.type} ${e.taskId}${detail}`);
    }
  },
});
mgrRef = mgr;
const taskRepo = {};

function seed(taskId, lane, repo, spec, claimExpect) {
  store.createTask({ task_id: taskId, lane, session_room: "e2e-fase2" });
  taskRepo[taskId] = repo;
  const claim = own.claimFiles(taskId, spec.files_owned);
  if (claim.status !== claimExpect) {
    fail("seed", `claim ${taskId} → ${claim.status} (harusnya ${claimExpect})`);
  }
  return claim;
}

const specA1 = {
  task_id: "a1",
  lane: "debug",
  objective: "fix bug: fungsi add salah return",
  files_owned: ["lib/math.py"],
  requirements: ["add(2,3) harus 5"],
  acceptance_criteria: ["pytest hijau di repo-a"],
  boundaries: ["hanya ubah lib/math.py"],
  verification_steps: [VERIFY_CMD],
};
const specA2 = {
  task_id: "a2",
  lane: "frontend",
  objective: "implement feature: fungsi double belum ada isinya",
  files_owned: ["lib/feature.py"],
  requirements: ["double(21) harus 42"],
  acceptance_criteria: ["pytest hijau di repo-b"],
  boundaries: ["hanya ubah lib/feature.py"],
  verification_steps: [VERIFY_CMD],
};
const specA3 = {
  task_id: "a3",
  lane: "qa",
  objective: "fix typo: sapaan greet salah eja",
  files_owned: ["lib/greet.py"],
  requirements: ["greet() harus 'Hello, world'"],
  acceptance_criteria: ["pytest hijau di repo-c"],
  boundaries: ["hanya ubah lib/greet.py"],
  verification_steps: [VERIFY_CMD],
};
const specB1 = {
  task_id: "b1",
  lane: "debug",
  objective: "implement feature: tambah fungsi mul (perkalian)",
  files_owned: ["lib/math.py"],
  requirements: ["mul(2,3) harus 6"],
  acceptance_criteria: ["pytest hijau di repo-a"],
  boundaries: ["hanya ubah lib/math.py"],
  verification_steps: [VERIFY_CMD],
};
const specB2 = {
  task_id: "b2",
  lane: "frontend",
  objective: "implement feature: tambah fungsi sub (pengurangan)",
  files_owned: ["lib/math.py"], // BENTROK dengan b1 — satu file satu owner
  requirements: ["sub(5,2) harus 3"],
  acceptance_criteria: ["pytest hijau di repo-a"],
  boundaries: ["hanya ubah lib/math.py"],
  verification_steps: [VERIFY_CMD],
};
const specC1 = {
  task_id: "c1",
  lane: "debug",
  objective: "fix bug: fungsi add salah return (task timeout berulang)",
  files_owned: ["lib/math.py"],
  requirements: ["add(2,3) harus 5"],
  acceptance_criteria: ["pytest hijau di repo-a"],
  boundaries: ["hanya ubah lib/math.py"],
  verification_steps: [VERIFY_CMD],
};

await mgr.start();

// ============================ SKENARIO A ============================
log("scenario A — paralel bersih: 3 task independen (repo-a, repo-b, repo-c)");
seed("a1", "debug", REPO_A, specA1, "ok");
seed("a2", "frontend", REPO_B, specA2, "ok");
seed("a3", "qa", REPO_C, specA3, "ok");
for (const [id, repo, spec] of [
  ["a1", REPO_A, specA1],
  ["a2", REPO_B, specA2],
  ["a3", REPO_C, specA3],
]) {
  const r = await mgr.spawnTask(id, repo, { spec, mock: true });
  log(`spawn ${id} → ${r.status}`);
}
await mgr.drain();
for (const id of ["a1", "a2", "a3"]) {
  const rec = store.getTask(id);
  if (rec.status !== "done") fail("scenario-A", `${id} status=${rec.status} error=${rec.error}`);
}
if (maxRunning > 3) fail("scenario-A", `pool melebihi cap: maxRunning=${maxRunning}`);
if (maxRunning !== 3) fail("scenario-A", `paralelisme tidak terbukti: maxRunning=${maxRunning} (harusnya 3)`);
if (maxInflightMerge > 1) fail("scenario-A", `merge paralel: maxInflightMerge=${maxInflightMerge}`);
log(`scenario A RESULT: PASS — 3 done, maxRunning=${maxRunning}, merge sequential`);

// ============================ SKENARIO B ============================
log("scenario B — konflik: 2 task menyentuh lib/math.py (repo-a)");
const confBefore = own.conflictCount();
seed("b1", "debug", REPO_A, specB1, "ok");
const claimB2 = seed("b2", "frontend", REPO_A, specB2, "conflict");
if (!claimB2.conflictsWith.includes("b1")) fail("scenario-B", `conflictsWith b2 salah: ${JSON.stringify(claimB2)}`);

await mgr.spawnTask("b1", REPO_A, { spec: specB1, mock: true });
await mgr.spawnTask("b2", REPO_A, { spec: specB2, mock: true });
if (mgr.queuedCount() !== 1 || !mgr.peekQueued().includes("b2")) {
  fail("scenario-B", `b2 harus tetap queued saat b1 running (queued=[${mgr.peekQueued().join(",")}])`);
}
log("scenario B pre-spawn OK: b2 queued menunggu owner b1");
await mgr.drain();
if (store.getTask("b1").status !== "done") fail("scenario-B", `b1 status=${store.getTask("b1").status}`);
if (store.getTask("b2").status !== "done") fail("scenario-B", `b2 status=${store.getTask("b2").status}`);
if (own.conflictCount() < confBefore + 1) fail("scenario-B", "counter conflict_detected tidak naik");
const orderB = mergeOrder.filter((t) => t === "b1" || t === "b2");
if (!(orderB[0] === "b1" && orderB[1] === "b2")) {
  fail("scenario-B", `urutan merge B salah: [${orderB.join(",")}]`);
}
log(`scenario B RESULT: PASS — conflict-detected ≥ 1 (total ${own.conflictCount()}), 0 merge paralel, sequential b1→b2`);

// ============================ SKENARIO C ============================
log("scenario C — gagal berulang: task timeout terus → retry 2× → failed");
seed("c1", "debug", REPO_A, specC1, "ok");
const spawnC = await mgr.spawnTask("c1", REPO_A, {
  spec: specC1,
  mock: true,
  timeoutMs: 600, // worker tidur 60s → selalu TIMEOUT (uji retry step idempoten)
  maxRetries: 2,
  env: { OMP_BRIDGE_MOCK_SLEEP_MS: "60000" },
});
log(`spawn c1 → ${spawnC.status}`);
await mgr.drain();
const recC = store.getTask("c1");
if (recC.status !== "failed") fail("scenario-C", `c1 status=${recC.status} (harusnya failed)`);
if (!recC.error || recC.error.length === 0) fail("scenario-C", "c1 error kosong");
if (!recC.error.includes("TIMEOUT")) fail("scenario-C", `c1 error tanpa TIMEOUT: ${recC.error}`);
log(`scenario C RESULT: PASS — c1 failed error="${recC.error}" (3 attempts: 1 awal + 2 retry backoff)`);

// ============================ END-STATE ============================
clearInterval(poll);
mgr.stop();
store.close();
log(`END-STATE driver: maxRunning=${maxRunning}, maxInflightMerge=${maxInflightMerge}, mergeOrder=[${mergeOrder.join(",")}]`);
if (maxInflightMerge > 1) fail("end-state", `merge paralel terjadi (maxInflightMerge=${maxInflightMerge})`);
if (!existsSync(join(ARTIFACTS, "a1", "merge.json"))) fail("end-state", "artifact merge.json a1 tidak ada");
log("PIPELINE FASE-2: OK (assertion akhir di assert-fase2.mjs)");
process.exit(0);
