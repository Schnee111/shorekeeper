/**
 * assert-fase2.mjs — end-state assertion E2E FASE-2 (TASK-2.4).
 * Nilai STATE AKHIR (store + ownership + git) setelah run-fase2.mjs:
 * - skenario A → 3 done + 3 merge commit (merge.json valid, sha ≥ 7 char)
 * - skenario B → 0 merge paralel & conflict-detected ≥ 1 kali
 * - skenario C → failed dengan error non-kosong (TIMEOUT)
 * - main branch hanya berisi commit dari task yang AC hijau (repo-a=4: initial
 *   + a1 + b1 + b2; c1 gagal tidak ter-merge) ; worktree worker bersih.
 * Exit 0 = semua benar.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../../packages/task-store/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DB = arg("--db") ?? join(ROOT, "data", "tasks-fase2.db");
const OWNERSHIP = join(ROOT, "data", "ownership.json");
const ARTIFACTS = join(ROOT, "data", "artifacts");
const REPO_A = join(ROOT, "tests", "fixtures", "repo-a");
const REPO_B = join(ROOT, "tests", "fixtures", "repo-b");
const REPO_C = join(ROOT, "tests", "fixtures", "repo-c");

function runGit(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

const failures = [];
function check(label, ok, detail = "") {
  console.log(`[assert-fase2] ${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const store = new TaskStore({ dbPath: DB });
try {
  // --- skenario A: 3 done + 3 merge commit ---
  for (const id of ["a1", "a2", "a3"]) {
    const t = store.getTask(id);
    check(`A: ${id} status=done`, t && t.status === "done", t ? `status=${t.status} error=${t.error}` : "not found");
    const mj = join(ARTIFACTS, id, "merge.json");
    let okMj = false;
    let sha = "";
    if (existsSync(mj)) {
      const parsed = JSON.parse(readFileSync(mj, "utf8"));
      sha = parsed.merge_commit ?? "";
      okMj = /^[0-9a-f]{7,}$/.test(sha);
    }
    check(`A: ${id} merge_commit valid (≥7 char)`, okMj, sha ? sha.slice(0, 12) : "merge.json tidak ada");
  }

  // --- skenario B: conflict-detected ≥ 1 + tidak ada merge paralel ---
  const own = JSON.parse(readFileSync(OWNERSHIP, "utf8"));
  const conflictCount = own.counters?.conflict_detected ?? 0;
  check("B: conflict-detected ≥ 1 kali", conflictCount >= 1, `counter=${conflictCount}`);
  const hasLog = (own.log ?? []).some((l) => l.startsWith("conflict-detected"));
  check("B: log ownership memuat conflict-detected", hasLog, (own.log ?? []).join(" | "));
  for (const id of ["b1", "b2"]) {
    const t = store.getTask(id);
    check(`B: ${id} status=done (sequential)`, t && t.status === "done", t ? `status=${t.status}` : "not found");
  }

  // --- skenario C: failed dengan error non-kosong ---
  const c1 = store.getTask("c1");
  check("C: c1 status=failed", c1 && c1.status === "failed", c1 ? `status=${c1.status}` : "not found");
  check("C: c1 error non-kosong", c1 && (c1.error ?? "").length > 0, c1 ? c1.error : "");
  check("C: c1 error memuat TIMEOUT", c1 && (c1.error ?? "").includes("TIMEOUT"), c1 ? c1.error : "");

  // --- main branch: hanya commit dari task AC hijau ---
  // repo-a: initial + a1 + b1 + b2 = 4 (c1 gagal → tidak ter-merge)
  check("repo-a main = 4 commit (initial+a1+b1+b2)", runGit(REPO_A, ["rev-list", "--count", "HEAD"]) === "4", runGit(REPO_A, ["rev-list", "--count", "HEAD"]));
  check("repo-b main = 2 commit (initial+a2)", runGit(REPO_B, ["rev-list", "--count", "HEAD"]) === "2", runGit(REPO_B, ["rev-list", "--count", "HEAD"]));
  check("repo-c main = 2 commit (initial+a3)", runGit(REPO_C, ["rev-list", "--count", "HEAD"]) === "2", runGit(REPO_C, ["rev-list", "--count", "HEAD"]));

  // --- worktree & branch worker bersih ---
  for (const [name, repo] of [["repo-a", REPO_A], ["repo-b", REPO_B], ["repo-c", REPO_C]]) {
    runGit(repo, ["worktree", "prune"]);
    const branches = runGit(repo, ["branch", "--list", "worker/*"]);
    check(`${name}: tidak ada branch worker tersisa`, branches.trim() === "", branches.trim() || "(kosong)");
    const wts = runGit(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
    check(`${name}: hanya 1 worktree utama`, wts.length === 1, `${wts.length} worktree`);
  }

  // --- store konsisten ---
  check("integrity_check = ok", store.integrityCheck() === "ok", store.integrityCheck());
  const stale = store.staleTasks(60);
  check("staleTasks(60s) kosong", stale.length === 0, `${stale.length} stale`);
} finally {
  store.close();
}

if (failures.length > 0) {
  console.error(`END-STATE FASE-2: FAIL — ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("END-STATE FASE-2: OK");
process.exit(0);
