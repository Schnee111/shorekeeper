/**
 * smoke-omp.mjs — driver POC bridge (TASK-1.3): delegasi 1 task "fix fungsi add"
 * ke worker (MOCK mode) di tests/fixtures/repo-a.
 * Bukti: test fixture merah sebelum worker → hijau setelah worker (di worktree),
 * diffSummary tercetak, perubahan HANYA di worktree (repo utama tidak disentuh).
 *
 * Dipanggil scripts/e2e/smoke-omp.sh (env: OMP_BRIDGE_MOCK=1, OMP_BRIDGE_ALLOWLIST,
 * SHOREKEEPER_VERIFY_CMD). Exit 0 = POC sukses.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeWorktree, runTask } from "../../packages/omp-bridge/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "repo-a");
const VERIFY_CMD = process.env.SHOREKEEPER_VERIFY_CMD;

function log(msg) {
  console.log(`[smoke-omp] ${msg}`);
}

// --- 0. preflight: test fixture harus MERAH sebelum worker ---
log(`preflight: pytest fixture sebelum worker (harus merah) di ${FIXTURE}`);
let redBefore = false;
try {
  execFileSync(VERIFY_CMD, { cwd: FIXTURE, stdio: "pipe", shell: true });
} catch {
  redBefore = true;
}
if (!redBefore) {
  log("FAIL: fixture harusnya merah sebelum worker (bootstrap rusak?)");
  process.exit(1);
}
log("preflight OK: fixture merah sebelum worker");

// --- 1. task spec (format TASK-1.2 / docs/api.md §2.3) ---
const spec = {
  task_id: "task_smoke_01",
  lane: "debug",
  objective: "fix bug: fungsi add salah return",
  files_owned: ["lib/math.py"],
  requirements: ["add(2,3) harus 5", "add(0,0) harus 0"],
  acceptance_criteria: ["pytest hijau di fixture repo-a"],
  boundaries: ["hanya ubah lib/math.py", "jangan ubah tests/"],
  verification_steps: [VERIFY_CMD],
};

// --- 2. delegasi via bridge (mock worker, worktree terisolasi) ---
log(`delegasi task ${spec.task_id} → ${FIXTURE} (OMP_BRIDGE_MOCK=1)`);
const result = await runTask(spec, FIXTURE, {
  allowlist: [FIXTURE],
  timeoutMs: 120_000,
  keepWorktree: true,
});

if (result.status !== "ok") {
  log(`FAIL: ${result.code} — ${result.message}`);
  process.exit(1);
}
log(`worker exitCode=${result.exitCode}`);
if (result.exitCode !== 0) {
  log(`FAIL: worker selesai tapi test MERAH (exit ${result.exitCode}) — jangan dianggap sukses`);
  log(`stdoutTail:\n${result.stdoutTail}`);
  process.exit(1);
}

// --- 3. verifikasi eksplisit di worktree (hijau) ---
log("verifikasi: pytest di worktree (harus hijau)");
try {
  execFileSync(VERIFY_CMD, { cwd: result.worktree, stdio: "pipe", shell: true });
} catch {
  log("FAIL: test di worktree masih merah");
  removeWorktree(FIXTURE, result.worktree);
  process.exit(1);
}

// --- 4. diffSummary + isolasi ---
console.log(`\n[diffSummary]\n${result.diffSummary}\n`);
const mainMath = readFileSync(join(FIXTURE, "lib", "math.py"), "utf8");
if (mainMath.includes("return a + b")) {
  log("FAIL: repo utama ikut berubah — worker menyentuh repo langsung (harusnya hanya worktree)");
  process.exit(1);
}
log("OK: repo utama (tests/fixtures/repo-a) TIDAK berubah — worker hanya di worktree");
removeWorktree(FIXTURE, result.worktree);
log("OK: worktree dibersihkan");
log("SMOKE-OMP: PASS — fixture merah → hijau oleh worker, diffSummary di atas");
process.exit(0);