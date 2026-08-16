/**
 * store.ts — TaskStore SQLite (WAL) untuk Shorekeeper.
 *
 * Kontrak: packages/contracts (TaskRecordSchema, canTransition) — source of truth
 * docs/api.md §2.2. Semua status task survive restart; single-writer = orchestrator.
 *
 * Disiplin:
 * - WAL mode + busy_timeout=5000 (dua proses tulis → tunggu ≤5s lalu error jelas).
 * - Status HANYA lewat state machine (canTransition) — transisi invalid →
 *   error `INVALID_TRANSITION`, tidak silent-allow.
 * - `summary` ≤ 200 kata di-enforce di layer API (bukan DB).
 * - Artifact besar > 1KB → filesystem; DB hanya menyimpan path (artifact_dir).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  TaskRecordSchema,
  canTransition,
  summaryMaxWords,
  type TaskRecord,
  type TaskStatus,
} from "handoff-contract";

export const STORE_VERSION = "0.1.0";
export const DEFAULT_DB_PATH = "data/tasks.db";
export const MAX_ARTIFACT_INLINE_BYTES = 1024;

const STATUSES: TaskStatus[] = ["queued", "running", "done", "failed", "cancelled", "blocked"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id       TEXT PRIMARY KEY,
  session_room  TEXT NOT NULL DEFAULT '',
  user_intent   TEXT NOT NULL DEFAULT '',
  parent_id     TEXT,
  lane          TEXT NOT NULL DEFAULT 'debug'
                CHECK (lane IN ('research','frontend','debug','qa')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','cancelled','blocked')),
  worker_pid    INTEGER,
  heartbeat_ts  INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  contract_ref  TEXT NOT NULL DEFAULT '',
  artifact_dir  TEXT,
  summary       TEXT NOT NULL DEFAULT '',
  error         TEXT,
  notify_gate   TEXT NOT NULL DEFAULT 'next_turn'
                CHECK (notify_gate IN ('idle','next_turn','off')),
  priority      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`;

export class TaskStoreError extends Error {
  constructor(
    public code:
      | "INVALID_TRANSITION"
      | "NOT_FOUND"
      | "DUPLICATE_TASK"
      | "SUMMARY_TOO_LONG"
      | "INVALID_INPUT"
      | "DB_BUSY",
    message: string,
  ) {
    super(message);
    this.name = "TaskStoreError";
  }
}

export interface TaskStoreOptions {
  /** Path DB (default data/tasks.db). ":memory:" untuk test. */
  dbPath?: string;
  /** Sumber epoch ms — injectable untuk fake timer (test stale detection). */
  now?: () => number;
}

export interface TransitionMeta {
  summary?: string;
  artifact_dir?: string | null;
  error?: string | null;
  worker_pid?: number | null;
}

export interface TouchHeartbeatResult {
  ok: boolean;
  code?: "NOT_FOUND" | "NOT_RUNNING";
  record?: TaskRecord;
}

/** Hitung jumlah kata (kontrak voice: summary ≤ 200 kata). */
export function countWords(s: string): number {
  return s.trim().length === 0 ? 0 : s.trim().split(/\s+/).length;
}

function assertSummaryOk(summary: string | undefined): void {
  if (summary === undefined) return;
  if (countWords(summary) > summaryMaxWords) {
    throw new TaskStoreError(
      "SUMMARY_TOO_LONG",
      `summary ${countWords(summary)} kata > batas ${summaryMaxWords} kata (kontrak voice)`,
    );
  }
}

/** Kunci baris DB → TaskRecord ter-validasi zod (kontrak dijaga di tiap read). */
function rowToRecord(row: unknown): TaskRecord {
  const parsed = TaskRecordSchema.safeParse(row);
  if (!parsed.success) {
    throw new TaskStoreError("INVALID_INPUT", `baris tasks tidak valid vs kontrak: ${parsed.error.message}`);
  }
  return parsed.data;
}

export class TaskStore {
  private db: Database.Database;
  private nowMs: () => number;

  constructor(opts: TaskStoreOptions = {}) {
    const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.nowMs = opts.now ?? (() => Date.now());
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.db = new Database(dbPath);
    // WAL + busy_timeout (TASK-1.4): dua proses tulis bareng → tunggu ≤5s lalu error jelas.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    // WAL best practice: synchronous NORMAL aman & cepat untuk single-writer.
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // -- PRAGMA (untuk test & debugging) ------------------------------------

  journalMode(): string {
    return this.db.pragma("journal_mode", { simple: true }) as string;
  }

  busyTimeout(): number {
    return this.db.pragma("busy_timeout", { simple: true }) as number;
  }

  integrityCheck(): string {
    return this.db.pragma("integrity_check", { simple: true }) as string;
  }

  // -- CRUD ----------------------------------------------------------------

  createTask(input: Partial<TaskRecord> & { task_id: string }): TaskRecord {
    const now = this.nowMs();
    assertSummaryOk(input.summary);
    const record = TaskRecordSchema.parse({
      task_id: input.task_id,
      session_room: input.session_room ?? "",
      user_intent: input.user_intent ?? "",
      parent_id: input.parent_id ?? null,
      lane: input.lane ?? "debug",
      status: input.status ?? "queued",
      worker_pid: input.worker_pid ?? null,
      heartbeat_ts: input.heartbeat_ts ?? null,
      created_at: input.created_at ?? now,
      started_at: input.started_at ?? null,
      finished_at: input.finished_at ?? null,
      contract_ref: input.contract_ref ?? "",
      artifact_dir: input.artifact_dir ?? null,
      summary: input.summary ?? "",
      error: input.error ?? null,
      notify_gate: input.notify_gate ?? "next_turn",
      priority: input.priority ?? 1,
    });
    try {
      this.db
        .prepare(
          `INSERT INTO tasks
           (task_id, session_room, user_intent, parent_id, lane, status, worker_pid,
            heartbeat_ts, created_at, started_at, finished_at, contract_ref,
            artifact_dir, summary, error, notify_gate, priority)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.task_id,
          record.session_room,
          record.user_intent,
          record.parent_id,
          record.lane,
          record.status,
          record.worker_pid,
          record.heartbeat_ts,
          record.created_at,
          record.started_at,
          record.finished_at,
          record.contract_ref,
          record.artifact_dir,
          record.summary,
          record.error,
          record.notify_gate,
          record.priority,
        );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        throw new TaskStoreError("DUPLICATE_TASK", `task ${record.task_id} sudah ada`);
      }
      if (msg.includes("busy") || msg.includes("locked")) {
        throw new TaskStoreError("DB_BUSY", `database sibuk: ${msg}`);
      }
      throw err;
    }
    return this.getTaskOrThrow(record.task_id);
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    return row ? rowToRecord(row) : null;
  }

  private getTaskOrThrow(taskId: string): TaskRecord {
    const rec = this.getTask(taskId);
    if (!rec) throw new TaskStoreError("NOT_FOUND", `task ${taskId} tidak ditemukan`);
    return rec;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC, task_id ASC").all();
    return rows.map(rowToRecord);
  }

  // -- State machine --------------------------------------------------------

  /**
   * Transisi status VIA state machine (canTransition). Transisi invalid →
   * INVALID_TRANSITION (jangan silent-allow). Meta opsional: summary (≤200 kata),
   * artifact_dir, error, worker_pid.
   */
  transition(taskId: string, to: TaskStatus, meta: TransitionMeta = {}): TaskRecord {
    const before = this.getTaskOrThrow(taskId);
    if (!canTransition(before.status, to)) {
      throw new TaskStoreError(
        "INVALID_TRANSITION",
        `transisi ${before.status} → ${to} tidak diizinkan (task ${taskId})`,
      );
    }
    assertSummaryOk(meta.summary);
    const now = this.nowMs();
    const startedAt = to === "running" ? (before.started_at ?? now) : before.started_at;
    const finishedAt =
      to === "done" || to === "failed" || to === "cancelled" ? (before.finished_at ?? now) : before.finished_at;
    const heartbeat = to === "running" ? (before.heartbeat_ts ?? now) : before.heartbeat_ts;

    const beforeRec = TaskRecordSchema.parse({ ...before, status: to });
    const candidate = TaskRecordSchema.parse({
      ...beforeRec,
      status: to,
      started_at: startedAt,
      finished_at: finishedAt,
      heartbeat_ts: heartbeat,
      worker_pid: meta.worker_pid !== undefined ? meta.worker_pid : before.worker_pid,
      summary: meta.summary !== undefined ? meta.summary : before.summary,
      artifact_dir: meta.artifact_dir !== undefined ? meta.artifact_dir : before.artifact_dir,
      error: meta.error !== undefined ? meta.error : before.error,
    });

    this.db
      .prepare(
        `UPDATE tasks SET status=?, started_at=?, finished_at=?, worker_pid=?, heartbeat_ts=?,
         summary=?, artifact_dir=?, error=? WHERE task_id=?`,
      )
      .run(
        candidate.status,
        candidate.started_at,
        candidate.finished_at,
        candidate.worker_pid,
        candidate.heartbeat_ts,
        candidate.summary,
        candidate.artifact_dir,
        candidate.error,
        candidate.task_id,
      );
    return this.getTaskOrThrow(taskId);
  }

  /** Shortcut: transisi ke done dengan summary + artifact_dir. */
  completeTask(taskId: string, meta: { summary: string; artifact_dir?: string }): TaskRecord {
    return this.transition(taskId, "done", meta);
  }

  /** Shortcut: transisi ke failed dengan error. */
  failTask(taskId: string, error: string): TaskRecord {
    return this.transition(taskId, "failed", { error });
  }

  // -- Heartbeat & stale -----------------------------------------------------

  /** Update heartbeat_ts (liveness worker). Hanya bermakna saat running. */
  touchHeartbeat(taskId: string): TouchHeartbeatResult {
    const rec = this.getTask(taskId);
    if (!rec) return { ok: false, code: "NOT_FOUND" };
    if (rec.status !== "running") return { ok: false, code: "NOT_RUNNING", record: rec };
    this.db.prepare("UPDATE tasks SET heartbeat_ts = ? WHERE task_id = ?").run(this.nowMs(), taskId);
    return { ok: true, record: this.getTaskOrThrow(taskId) };
  }

  /**
   * staleTasks(ttlSeconds): task running dengan heartbeat basi (atau tanpa heartbeat)
   * → transisi ke failed dengan alasan `STALE_HEARTBEAT` (kandidat retry/quarantine).
   * Return daftar task yang di-mark.
   */
  staleTasks(ttlSeconds: number): TaskRecord[] {
    const cutoff = this.nowMs() - ttlSeconds * 1000;
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'running' AND (heartbeat_ts IS NULL OR heartbeat_ts < ?)",
      )
      .all(cutoff);
    return rows.map((row) => {
      const rec = rowToRecord(row);
      return this.transition(rec.task_id, "failed", { error: "STALE_HEARTBEAT" });
    });
  }

  // -- Voice-optimized query ---------------------------------------------------

  public static readonly STATUS_LABELS: Record<TaskStatus, string> = {
    queued: "menunggu antrian",
    running: "sedang dikerjakan",
    done: "selesai",
    failed: "gagal",
    cancelled: "dibatalkan",
    blocked: "terblokir (menunggu dependency)",
  };

  /**
   * checkTaskStatus(taskIds | "active") — pull status untuk voice.
   * Output `narratable` ≤ 5 baris + `counts` (zero hallucination: semua angka
   * dari store). Task tak dikenal → { status: "not_found" }, TIDAK throw.
   */
  checkTaskStatus(query: string[] | "active"): CheckTaskStatusResult {
    const ids =
      query === "active"
        ? (this.db
            .prepare(
              "SELECT task_id FROM tasks WHERE status IN ('queued','running','blocked') ORDER BY priority DESC, created_at ASC",
            )
            .all()
            .map((r) => (r as { task_id: string }).task_id) as string[])
        : [...new Set(query)];

    const tasks: Record<string, CheckTaskStatusEntry> = {};
    const counts: Record<string, number> = {};
    for (const s of [...STATUSES, "not_found"]) counts[s] = 0;
    counts.total = 0;

    const narratable: string[] = [];
    for (const id of ids) {
      const rec = this.getTask(id);
      if (!rec) {
        tasks[id] = { status: "not_found" };
        counts.not_found = (counts.not_found ?? 0) + 1;
        narratable.push(`Task ${id} tidak ditemukan.`);
        continue;
      }
      tasks[id] = {
        status: rec.status,
        lane: rec.lane,
        summary: rec.summary || undefined,
        error: rec.error,
      };
      counts[rec.status] = (counts[rec.status] ?? 0) + 1;
      counts.total = (counts.total ?? 0) + 1;
      let line = `Task ${rec.task_id} (${rec.lane}): ${TaskStore.STATUS_LABELS[rec.status]}.`;
      if (rec.status === "done" && rec.summary) {
        const head = rec.summary.length > 100 ? `${rec.summary.slice(0, 100)}…` : rec.summary;
        line = `Task ${rec.task_id} (${rec.lane}) selesai: ${head}.`;
      } else if (rec.status === "failed" && rec.error) {
        line = `Task ${rec.task_id} (${rec.lane}) gagal: ${rec.error}.`;
      }
      narratable.push(line);
    }
    counts.total = (counts.total ?? 0) + (counts.not_found ?? 0);

    // Batas ≤ 5 baris naratif (kontrak voice): sisanya dirangkum satu baris.
    const MAX_LINES = 5;
    if (narratable.length > MAX_LINES) {
      const first = narratable.slice(0, MAX_LINES - 1);
      const rest = narratable.length - first.length;
      const total = ids.length;
      first.push(`…dan ${rest} task lainnya (total ${total} diproses).`);
      return { narratable: first, counts, tasks };
    }
    return { narratable, counts, tasks };
  }

  // -- Artifact (filesystem, DB hanya path) ------------------------------------

  /**
   * Simpan konten artifact ke filesystem: <artifactDirBase>/<taskId>/<relPath>,
   * lalu set task.artifact_dir. Konten > 1KB WAJIB di filesystem (test memverifikasi
   * DB tidak memuat isinya); ≤ 1KB boleh ikut disimpan inline (uniform: tetap file).
   */
  storeArtifactContent(
    taskId: string,
    artifactDirBase: string,
    relPath: string,
    content: string | Buffer,
  ): { artifactDir: string; filePath: string } {
    const artifactDir = join(resolve(artifactDirBase), taskId);
    const filePath = join(artifactDir, relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    const rec = this.getTask(taskId);
    if (rec && rec.artifact_dir === null) {
      this.db.prepare("UPDATE tasks SET artifact_dir = ? WHERE task_id = ?").run(artifactDir, taskId);
    }
    return { artifactDir, filePath };
  }
}

export interface CheckTaskStatusEntry {
  status: TaskStatus | "not_found";
  lane?: string;
  summary?: string;
  error?: string | null;
}

export interface CheckTaskStatusResult {
  /** ≤ 5 baris naratif (Bahasa Indonesia, angka dari store). */
  narratable: string[];
  counts: Record<string, number>;
  tasks: Record<string, CheckTaskStatusEntry>;
}