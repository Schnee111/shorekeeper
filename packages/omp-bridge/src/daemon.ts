import { resolve, join } from "node:path";
import { TaskStore } from "task-store";

const ROOT = resolve(process.cwd(), "../..");
const DB_PATH = process.env.SHOREKEEPER_DB || join(ROOT, "data", "tasks.db");

console.log(`[daemon] Starting Shorekeeper Background Worker Daemon...`);
console.log(`[daemon] Monitoring DB: ${DB_PATH}`);

const store = new TaskStore({ dbPath: DB_PATH });
let isRunning = true;

async function pollLoop() {
  console.log(`[daemon] Polling loop active (interval: 1.0s)`);
  while (isRunning) {
    try {
      const allTasks = store.listTasks();
      const queued = allTasks.filter((t) => t.status === "queued");
      for (const t of queued) {
        console.log(`[daemon] Processing task: ${t.task_id} (${t.user_intent})`);
        store.transition(t.task_id, "running");
        
        // Simulasikan pengerjaan task oleh background worker / Hermes
        await new Promise((r) => setTimeout(r, 2000));

        store.completeTask(t.task_id, {
          summary: `Pekerjaan '${t.user_intent}' telah selesai dieksekusi oleh background worker dengan sukses.`,
        });
        console.log(`[daemon] Task ${t.task_id} completed successfully!`);
      }
    } catch (e: any) {
      console.error(`[daemon] Error in poll loop:`, e?.message || e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

process.on("SIGINT", () => {
  isRunning = false;
  store.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  isRunning = false;
  store.close();
  process.exit(0);
});

pollLoop().catch((e) => {
  console.error(`[daemon] Fatal:`, e);
  process.exit(1);
});
