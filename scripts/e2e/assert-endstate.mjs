/**
 * assert-endstate.mjs — end-state assertion E2E FASE-1 (TASK-1.5).
 * Nilai STATE AKHIR (store + filesystem), bukan langkah per langkah:
 * - persis 1 task, status=done
 * - summary non-kosong ≤ 200 kata
 * - artifact_dir ada & berisi diff
 * - staleTasks(60s) kosong
 * - integrity_check = ok
 * Exit 0 = semua benar.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore, countWords } from "../../packages/task-store/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DB = arg("--db") ?? join(ROOT, "data", "tasks-e2e.db");

const failures = [];
function check(label, ok, detail = "") {
  console.log(`[assert] ${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const store = new TaskStore({ dbPath: DB });
try {
  const tasks = store.listTasks();
  check("tepat 1 task", tasks.length === 1, `ditemukan ${tasks.length}`);
  const t = tasks[0];
  if (t) {
    check(`status=done (${t.task_id})`, t.status === "done", `status=${t.status}`);
    const words = countWords(t.summary ?? "");
    check("summary non-kosong", (t.summary ?? "").trim().length > 0);
    check("summary ≤ 200 kata", words <= 200, `${words} kata`);
    check("artifact_dir terisi", Boolean(t.artifact_dir), t.artifact_dir ?? "null");
    if (t.artifact_dir) {
      const patch = join(t.artifact_dir, "diff.patch");
      const stat = join(t.artifact_dir, "diff-stat.txt");
      check("artifact berisi diff.patch", existsSync(patch) && readFileSync(patch, "utf8").trim().length > 0);
      check("artifact berisi diff-stat.txt", existsSync(stat) && readFileSync(stat, "utf8").trim().length > 0);
    }
  }
  const stale = store.staleTasks(60);
  check("staleTasks(60s) kosong", stale.length === 0, `${stale.length} stale`);
  check("integrity_check = ok", store.integrityCheck() === "ok", store.integrityCheck());
} finally {
  store.close();
}

if (failures.length > 0) {
  console.error(`END-STATE: FAIL — ${failures.join(", ")}`);
  process.exit(1);
}
console.log("END-STATE: OK");
process.exit(0);