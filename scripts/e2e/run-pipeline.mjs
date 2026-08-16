/**
 * run-pipeline.mjs — driver E2E FASE-1 (TASK-1.5): jalur utuh 1 task.
 *
 * Alur (data-flow):
 *   seed task (queued) → running (+heartbeat) → runTask (omp-bridge, MOCK) →
 *   artifact (diff) → commit worktree + merge ke fixture (orchestrator merge gate) →
 *   verifier rerun pytest fixture (WAJIB hijau; merah → failed/VERIFY_FAILED) →
 *   done + summary (≤200 kata) + artifact_dir → cleanup worktree.
 *
 * Exit: 0 = pipeline sukses; 1 = gagal (message diawali `stage=<nama>`).
 * Dipanggil scripts/e2e/run-fase1.sh.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../../packages/task-store/dist/index.js";
import { removeWorktree, runTask } from "../../packages/omp-bridge/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const VERIFY_CMD = process.env.SHOREKEEPER_VERIFY_CMD ?? "";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DB = arg("--db") ?? join(ROOT, "data", "tasks-e2e.db");
const FIXTURE = arg("--repo") ?? join(ROOT, "tests", "fixtures", "repo-a");
const TASK_ID = "task_e2e_01";

if (!VERIFY_CMD) {
  console.error("stage=env: SHOREKEEPER_VERIFY_CMD wajib di-set");
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const store = new TaskStore({ dbPath: DB });
let worktree = null;

function cleanup() {
  try {
    if (worktree) removeWorktree(FIXTURE, worktree);
  } catch {
    // best-effort
  }
  try {
    store.close();
  } catch {
    // best-effort
  }
}

process.on("exit", cleanup);

function fail(stage, msg) {
  log(`FAILED stage=${stage}: ${msg}`);
  process.exitCode = 1;
}

function runGit(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

try {
  // --- 1. seed (state queued) ---
  const existing = store.getTask(TASK_ID);
  if (!existing) {
    store.createTask({
      task_id: TASK_ID,
      session_room: "e2e-fase1",
      user_intent: "fix bug: fungsi add salah return (fixture repo-a)",
      lane: "debug",
      contract_ref: "tests/fixtures/repo-a",
    });
  }
  log(`task ${TASK_ID} queued`);

  // --- 2. running + heartbeat ---
  store.transition(TASK_ID, "running", { worker_pid: process.pid });
  store.touchHeartbeat(TASK_ID);
  log(`task ${TASK_ID} running`);

  // --- 3. delegasi via bridge (mock worker) ---
  const spec = {
    task_id: TASK_ID,
    lane: "debug",
    objective: "fix bug: fungsi add salah return",
    files_owned: ["lib/math.py"],
    requirements: ["add(2,3) harus 5", "add(0,0) harus 0"],
    acceptance_criteria: ["pytest hijau di fixture repo-a"],
    boundaries: ["hanya ubah lib/math.py", "jangan ubah tests/"],
    verification_steps: [VERIFY_CMD],
  };
  const result = await runTask(spec, FIXTURE, {
    allowlist: [FIXTURE],
    timeoutMs: 300_000,
    keepWorktree: true,
  });
  if (result.status !== "ok") {
    store.failTask(TASK_ID, result.code);
    log(`task ${TASK_ID} failed (${result.code})`);
    fail("delegate", `${result.code}: ${result.message}`);
    process.exit(1);
  }
  worktree = result.worktree;
  log(`worker exitCode=${result.exitCode} (worktree: ${worktree})`);
  if (result.exitCode !== 0) {
    // worker selesai tapi test merah — JANGAN dianggap sukses
    store.failTask(TASK_ID, "VERIFY_FAILED");
    log(`task ${TASK_ID} failed (VERIFY_FAILED — worker test merah)`);
    fail("worker-verify", `worker exit ${result.exitCode} — verification_steps tidak hijau`);
    process.exit(1);
  }

  // --- 4. artifact: diff disimpan ke filesystem, DB hanya path ---
  const artifactDir = store.storeArtifactContent(
    TASK_ID,
    join(ROOT, "data", "artifacts"),
    "diff.patch",
    result.diffFull,
  ).artifactDir;
  store.storeArtifactContent(TASK_ID, join(ROOT, "data", "artifacts"), "diff-stat.txt", result.diffSummary);
  log(`artifact_dir=${artifactDir}`);

  // --- 5. merge gate (orchestrator): commit worktree → merge ke fixture main ---
  if (result.diffFull.trim().length > 0) {
    runGit(worktree, ["add", "-A"]);
    runGit(worktree, [
      "-c",
      "user.name=Shorekeeper Worker",
      "-c",
      "user.email=worker@shorekeeper.local",
      "commit",
      "-qm",
      `worker(done): ${TASK_ID}`,
    ]);
    runGit(FIXTURE, ["fetch", "-q", "--no-tags", worktree, "HEAD"]);
    runGit(FIXTURE, ["merge", "--no-edit", "-m", `orchestrator(merge): ${TASK_ID}`, "FETCH_HEAD"]);
    log(`task ${TASK_ID} merged ke fixture (orchestrator merge gate)`);
  } else {
    log(`task ${TASK_ID} tanpa perubahan dari worker — verifier tetap dijalankan`);
  }

  // --- 6. verifier: rerun test fixture — WAJIB hijau ---
  let verifyOut = "";
  let verifyOk = false;
  try {
    verifyOut = execFileSync("sh", ["-c", VERIFY_CMD], {
      cwd: FIXTURE,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    verifyOk = true;
  } catch (err) {
    verifyOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (!verifyOk) {
    store.failTask(TASK_ID, "VERIFY_FAILED");
    log(`task ${TASK_ID} failed (VERIFY_FAILED)`);
    log(`verify output (tail):\n${verifyOut.split("\n").slice(-8).join("\n")}`);
    fail("verify", "verifier: test fixture MERAH setelah worker selesai");
    process.exit(1);
  }
  const passLine = verifyOut.split("\n").find((l) => /\d+ passed/.test(l)) ?? "pytest hijau";
  log(`verifier: ${passLine.trim()}`);

  // --- 7. done + summary (≤200 kata, enforce di store API) ---
  const statLine = result.diffSummary.split("\n")[0] ?? "";
  const summary =
    `Worker memperbaiki fungsi add di lib/math.py (return a - b → return a + b); ` +
    `verifikasi ulang fixture hijau (${passLine.trim()}). ${statLine.trim()}`;
  store.completeTask(TASK_ID, { summary, artifact_dir: artifactDir });
  log(`task ${TASK_ID} done`);
  log(`summary=${summary}`);

  // --- 8. cleanup worktree ---
  if (worktree) {
    removeWorktree(FIXTURE, worktree);
    worktree = null;
  }
  log("PIPELINE: OK");
  process.exit(0);
} catch (err) {
  if (process.exitCode !== 1) process.exitCode = 1;
  log(`FAILED stage=pipeline-unexpected: ${err instanceof Error ? err.message : String(err)}`);
}