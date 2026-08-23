/**
 * assert-store-failed.mjs — assertion untuk test NEGATIF E2E FASE-1 (TASK-1.5):
 * pipeline gagal ⇒ store berisi tepat 1 task dengan status=failed & error=VERIFY_FAILED.
 * Exit 0 = state negatif terverifikasi.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../../packages/task-store/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB = (() => {
  const i = process.argv.indexOf("--db");
  return i >= 0 ? process.argv[i + 1] : join(ROOT, "data", "tasks-e2e.db");
})();

const store = new TaskStore({ dbPath: DB });
try {
  const tasks = store.listTasks();
  if (tasks.length !== 1) {
    console.error(`NEGATIVE-STORE: FAIL — diharapkan 1 task, ditemukan ${tasks.length}`);
    process.exit(1);
  }
  const t = tasks[0];
  const ok = t.status === "failed" && t.error === "VERIFY_FAILED";
  console.log(
    `[negative-store] ${ok ? "PASS" : "FAIL"} — ${t.task_id}: status=${t.status} error=${t.error}`,
  );
  if (!ok) process.exit(1);
  console.log("NEGATIVE-STORE: OK");
  process.exit(0);
} finally {
  store.close();
}