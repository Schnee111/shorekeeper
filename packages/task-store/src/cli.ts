#!/usr/bin/env node
/**
 * cli.ts — CLI minimal task-store (TASK-1.4): new/status/done/fail/list (+heartbeat/stale)
 * untuk debugging manual & dipakai E2E.
 *
 * Usage:
 *   task-store [--db PATH] new --task-id ID [--lane debug] [--intent "..."] [--contract-ref c]
 *   task-store [--db PATH] status <id... | active | --all>
 *   task-store [--db PATH] done ID --summary "..." [--artifact-dir DIR]
 *   task-store [--db PATH] fail ID --error "..."
 *   task-store [--db PATH] heartbeat ID
 *   task-store [--db PATH] stale TTL_SECONDS
 *   task-store [--db PATH] list [--status queued]
 *   task-store [--db PATH] backup DEST_PATH      # backup online (TASK-3.4)
 *
 * DB default: env TASKS_DB atau data/tasks.db. Output: JSON per baris.
 */
import { TaskStore, TaskStoreError, DEFAULT_DB_PATH } from "./store.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  console.error(
    [
      "task-store CLI — debugging manual task store (TASK-1.4)",
      "  task-store [--db PATH] new --task-id ID [--lane debug] [--intent s] [--contract-ref c] [--priority n]",
      "  task-store [--db PATH] status <id...|active|--all>",
      "  task-store [--db PATH] done ID --summary s [--artifact-dir d]",
      "  task-store [--db PATH] fail ID --error s",
      "  task-store [--db PATH] heartbeat ID",
      "  task-store [--db PATH] stale TTL_SECONDS",
      "  task-store [--db PATH] list [--status s]",
      "  task-store [--db PATH] backup DEST_PATH",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dbPath = process.env.TASKS_DB ?? DEFAULT_DB_PATH;
  let rest = argv;
  if (argv[0] === "--db") {
    dbPath = argv[1] ?? usage();
    rest = argv.slice(2);
  }
  const [cmd, ...args] = rest;
  if (!cmd) usage();

  const store = new TaskStore({ dbPath });
  try {
    switch (cmd) {
      case "new": {
        const taskId = flag(args, "--task-id") ?? usage();
        const record = store.createTask({
          task_id: taskId,
          lane: (flag(args, "--lane") as "debug" | undefined) ?? "debug",
          user_intent: flag(args, "--intent") ?? "",
          contract_ref: flag(args, "--contract-ref") ?? "",
          priority: Number(flag(args, "--priority") ?? 1),
          session_room: flag(args, "--session-room") ?? "",
        });
        console.log(JSON.stringify(record));
        break;
      }
      case "status": {
        const target = args[0];
        if (!target) usage();
        if (target === "--all") {
          const records = store.listTasks();
          for (const r of records) console.log(JSON.stringify(r));
        } else if (target === "active") {
          console.log(JSON.stringify(store.checkTaskStatus("active")));
        } else {
          console.log(JSON.stringify(store.checkTaskStatus(args)));
        }
        break;
      }
      case "done": {
        const taskId = args[0] ?? usage();
        const summary = flag(args, "--summary");
        if (summary === undefined) usage();
        const record = store.completeTask(taskId, {
          summary,
          artifact_dir: flag(args, "--artifact-dir"),
        });
        console.log(JSON.stringify(record));
        break;
      }
      case "run": {
        const taskId = args[0] ?? usage();
        const record = store.transition(taskId, "running", {
          worker_pid: Number(flag(args, "--worker-pid") ?? process.pid),
        });
        console.log(JSON.stringify(record));
        break;
      }
      case "fail": {
        const taskId = args[0] ?? usage();
        const error = flag(args, "--error");
        if (error === undefined) usage();
        console.log(JSON.stringify(store.failTask(taskId, error)));
        break;
      }
      case "heartbeat": {
        const taskId = args[0] ?? usage();
        console.log(JSON.stringify(store.touchHeartbeat(taskId)));
        break;
      }
      case "stale": {
        const ttl = Number(args[0] ?? 60);
        const marked = store.staleTasks(ttl);
        console.log(JSON.stringify(marked));
        break;
      }
      case "list": {
        const statusFilter = flag(args, "--status");
        const records = store.listTasks().filter((r) => !statusFilter || r.status === statusFilter);
        for (const r of records) console.log(JSON.stringify(r));
        break;
      }
      case "backup": {
        const dest = args[0] ?? usage();
        await store.backup(dest);
        console.log(JSON.stringify({ ok: true, backup_path: dest }));
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof TaskStoreError) {
      console.error(`task-store: ${err.code}: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    store.close();
  }
}

void main();