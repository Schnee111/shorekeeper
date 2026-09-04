/**
 * daemon.ts — production worker daemon (Sprint D.1, permanent fix).
 *
 * Menutup gap "delegate_task menulis ke SQLite tapi tidak ada yang eksekusi":
 *   poll SQLite `tasks` status='queued' tiap 500ms
 *   → claim atomik (queued → running)
 *   → eksekusi via Hermes gateway WS (session.create → prompt.submit → collect)
 *   → completeTask(summary) / failTask(error)
 *     (transition() otomatis mengisi notify_outbox → agent push ke voice)
 *
 * Env:
 *   SHOREKEEPER_DB   — path SQLite (default data/tasks.db dari repo root)
 *   HERMES_WS_URL    — ws://127.0.0.1:9119/api/ws (default)
 *   SK_MAX_PARALLEL  — maksimal task paralel (default 2, hard cap 3)
 *   SK_TASK_TIMEOUT  — timeout task ms (default 900000 = 15 menit)
 *   OMP_BRIDGE_MOCK  — "1" → executor mock deterministik (tanpa Hermes)
 */

import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "task-store";
import { applyMockFix } from "./mock-worker.js";
import { clipSummary, buildWsUrl, type HermesResult } from "./daemon-utils.js";

// Repo root = 3 level di atas file ini (packages/omp-bridge/dist/daemon.js).
// Jangan pakai process.cwd() — daemon bisa dijalankan dari mana saja (systemd, dev).
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const DB_PATH = process.env.SHOREKEEPER_DB || join(ROOT, "data", "tasks.db");
const HERMES_WS_URL = process.env.HERMES_WS_URL || "ws://127.0.0.1:9119/api/ws";
const HERMES_WS_TOKEN = process.env.HERMES_WS_TOKEN || process.env.HERMES_DASHBOARD_SESSION_TOKEN || "";
const MAX_PARALLEL = Math.min(3, Number(process.env.SK_MAX_PARALLEL ?? 2));
const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;
const TASK_TIMEOUT_MS = Number(process.env.SK_TASK_TIMEOUT ?? 900_000);
const STALE_TTL_SECONDS = 75;
const MOCK = process.env.OMP_BRIDGE_MOCK === "1";

function log(msg: string): void {
  console.log(`[daemon][${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function executeViaHermes(instruction: string): Promise<HermesResult> {
  const wsUrl = buildWsUrl(HERMES_WS_URL, HERMES_WS_TOKEN);
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map<number, (data: Record<string, unknown>) => void>();
  let collected = "";
  let lastDeltaAt = Date.now();
  let doneResolve: ((r: HermesResult) => void) | null = null;
  let finished = false;

  const finish = (r: HermesResult): void => {
    if (finished) return;
    finished = true;
    doneResolve?.(r);
  };

  ws.onmessage = (ev) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    // JSON-RPC response (ack session.create / prompt.submit)
    if (data.id !== undefined && data.id !== null) {
      const cb = pending.get(Number(data.id));
      if (cb) {
        pending.delete(Number(data.id));
        cb(data);
      }
      return;
    }
    if (data.method !== "event") return;
    const params = (data.params ?? {}) as Record<string, unknown>;
    const type = params.type as string;
    const payload = (params.payload ?? {}) as Record<string, unknown>;
    if (type === "message.delta" && typeof payload.text === "string") {
      collected += payload.text;
      lastDeltaAt = Date.now();
    } else if (type === "message.complete" || type === "turn.end" || type === "turn.complete") {
      const finalText = typeof payload.text === "string" && payload.text.trim().length > 0
        ? payload.text
        : collected;
      finish({ ok: true, summary: finalText });
    } else if (type === "session.error" || type === "error") {
      finish({ ok: false, summary: String(payload.message ?? payload.error ?? "hermes error") });
    }
  };
  ws.onerror = () => finish({ ok: false, summary: "Hermes WS error" });
  ws.onclose = () => finish({ ok: collected.trim().length > 0, summary: collected });

  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    msgId += 1;
    const id = msgId;
    return new Promise((res) => {
      pending.set(id, res);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };

  const opened = await new Promise<boolean>((res) => {
    const t = setTimeout(() => res(false), 8_000);
    ws.onopen = () => {
      clearTimeout(t);
      res(true);
    };
  });
  if (!opened) return { ok: false, summary: `Hermes gateway tidak reachable di ${buildWsUrl(HERMES_WS_URL, HERMES_WS_TOKEN).replace(/token=[^&]+/, "token=***")}` };

  const created = await rpc("session.create", {});
  if (created.error) return { ok: false, summary: `session.create gagal: ${JSON.stringify(created.error).slice(0, 200)}` };
  const sessionId = String((created.result as Record<string, unknown>)?.session_id ?? "");
  await rpc("session.activate", { session_id: sessionId });

  // Submit + kumpulkan stream; selesaikan saat message.complete ATAU idle 15s setelah delta terakhir.
  const result = await new Promise<HermesResult>((res) => {
    doneResolve = res;
    void rpc("prompt.submit", { session_id: sessionId, text: instruction });
    const idle = setInterval(() => {
      if (collected.length > 0 && Date.now() - lastDeltaAt > 15_000) {
        clearInterval(idle);
        finish({ ok: true, summary: collected });
      }
    }, 2_000);
    setTimeout(() => {
      clearInterval(idle);
      finish({ ok: collected.trim().length > 0, summary: collected || "timeout tanpa output" });
    }, TASK_TIMEOUT_MS);
  });

  try {
    ws.close();
  } catch {
    /* tutup best-effort */
  }
  return result;
}

// ---------------------------------------------------------------------------
// Daemon core
// ---------------------------------------------------------------------------

const store = new TaskStore({ dbPath: DB_PATH });
const active = new Map<string, ReturnType<typeof setInterval>>(); // task_id → heartbeat timer

function claimNext(): string | null {
  const queued = store
    .listTasks()
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);
  for (const t of queued) {
    try {
      store.transition(t.task_id, "running", { worker_pid: process.pid });
      return t.task_id;
    } catch {
      continue; // kalah race / transisi invalid — coba berikutnya
    }
  }
  return null;
}

async function runTask(taskId: string): Promise<void> {
  const rec = store.getTask(taskId);
  if (!rec) {
    // Slot placeholder dibersihkan caller via finally di pollLoop.
    return;
  }
  const instruction = rec.user_intent;
  log(`executing ${taskId} (lane=${rec.lane}): ${instruction.slice(0, 100)}`);

  // Heartbeat 15s selama task berjalan (single-writer: daemon ini).
  const hb = setInterval(() => {
    try {
      store.touchHeartbeat(taskId);
    } catch {
      /* task mungkin sudah terminal */
    }
  }, HEARTBEAT_MS);
  active.set(taskId, hb); // mengganti placeholder slot dari pollLoop

  try {
    let result: HermesResult;
    if (MOCK) {
      // Executor mock deterministik (dev tanpa Hermes gateway).
      await new Promise((r) => setTimeout(r, 1_500));
      result = {
        ok: true,
        summary: `Task '${instruction.slice(0, 80)}' selesai dikerjakan worker mock (deterministik, tanpa network).`,
      };
      applyMockFix(ROOT, { task_id: taskId, objective: instruction });
    } else {
      result = await executeViaHermes(instruction);
    }

    if (result.ok && result.summary.trim()) {
      store.completeTask(taskId, { summary: clipSummary(result.summary) });
      log(`task ${taskId} DONE → notify_outbox terisi`);
    } else {
      store.failTask(taskId, result.summary.slice(0, 300) || "EXECUTOR_EMPTY");
      log(`task ${taskId} FAILED: ${result.summary.slice(0, 120)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      store.failTask(taskId, msg.slice(0, 300));
    } catch {
      /* sudah terminal */
    }
    log(`task ${taskId} ERROR: ${msg.slice(0, 120)}`);
  } finally {
    clearInterval(active.get(taskId));
    active.delete(taskId);
  }
}

async function recoverStale(): Promise<void> {
  for (const rec of store.staleTasks(STALE_TTL_SECONDS)) {
    try {
      store.failTask(rec.task_id, "STALE_HEARTBEAT (daemon restart)");
      log(`recovered stale task ${rec.task_id} → failed/STALE_HEARTBEAT`);
    } catch {
      /* sudah terminal */
    }
  }
}

/** Reserve a slot synchronously, then dispatch. Placeholder removed if task is
 * missing; replaced by the real heartbeat timer inside runTask. */
function dispatch(taskId: string): void {
  active.set(taskId, undefined as unknown as ReturnType<typeof setInterval>);
  void runTask(taskId).finally(() => {
    // Jika runTask tidak sempat mendaftarkan hb (task hilang), bersihkan slot.
    const timer = active.get(taskId);
    if (timer === undefined) active.delete(taskId);
  });
}

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      if (active.size < MAX_PARALLEL) {
        const taskId = claimNext();
        if (taskId) {
          dispatch(taskId);
          continue; // langsung cek slot lagi (paralel)
        }
      }
    } catch (err) {
      log(`poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down (menunggu task aktif selesai, maks 10s)");
  const deadline = Date.now() + 10_000;
  const wait = setInterval(() => {
    if (active.size === 0 || Date.now() > deadline) {
      clearInterval(wait);
      store.close();
      process.exit(0);
    }
  }, 250);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`starting — db=${DB_PATH} hermes=${MOCK ? "MOCK" : HERMES_WS_URL} maxParallel=${MAX_PARALLEL}`);
await recoverStale();
await pollLoop();
