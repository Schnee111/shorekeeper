/**
 * task-store unit tests — TASK-1.4.
 * CRUD, state machine (valid + INVALID_TRANSITION), WAL + busy_timeout, not_found,
 * stale detection (fake timer), survive restart + integrity, artifact > 1KB di FS,
 * summary ≤ 200 kata di layer API, golden fixture checkTaskStatus.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore, TaskStoreError, countWords } from "../src/index.js";
import type { TaskRecord } from "handoff-contract";

const FIXTURE_JSON = "../../../tests/fixtures/taskstore-fixture.json";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-store-test-"));
  tmpDirs.push(d);
  return d;
}
function dbPath(tag: string): string {
  return join(tmp(), `${tag}.db`);
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTask(overrides: Record<string, unknown> = {}): Partial<TaskRecord> & { task_id: string } {
  return {
    task_id: "task_t_01",
    lane: "debug",
    user_intent: "perbaiki bug",
    contract_ref: "plans/task_t_01.md",
    created_at: 1723999000000,
    ...overrides,
  } as Partial<TaskRecord> & { task_id: string };
}

const oneLine = (n: number) => `kata${" x".repeat(n - 1)}`;

/** Pastikan fn melempar TaskStoreError dengan code tertentu. */
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TaskStoreError);
  expect((caught as TaskStoreError).code).toBe(code);
}

describe("CRUD", () => {
  it("createTask → getTask → listTasks; duplicate → DUPLICATE_TASK", () => {
    const store = new TaskStore({ dbPath: dbPath("crud") });
    store.createTask(makeTask({ task_id: "task_c_1" }));
    store.createTask(makeTask({ task_id: "task_c_2", lane: "qa" }));
    expect(store.getTask("task_c_1")?.status).toBe("queued");
    expect(store.listTasks()).toHaveLength(2);
    expect(() => store.createTask(makeTask({ task_id: "task_c_1" }))).toThrowError(
      /sudah ada/,
    );
    expect(store.getTask("task_tidak_ada")).toBeNull();
    store.close();
  });

  it("kolom opsional default mengikuti kontrak (TaskRecordSchema)", () => {
    const store = new TaskStore({ dbPath: dbPath("defaults") });
    const rec = store.createTask({ task_id: "task_def_1" });
    expect(rec.status).toBe("queued");
    expect(rec.lane).toBe("debug");
    expect(rec.notify_gate).toBe("next_turn");
    expect(rec.priority).toBe(1);
    expect(rec.created_at).toBeGreaterThan(0);
    store.close();
  });
});

describe("state machine (canTransition)", () => {
  it("queued→running→done valid; running→blocked→running valid; queued→cancelled valid", () => {
    const store = new TaskStore({ dbPath: dbPath("sm") });
    store.createTask(makeTask({ task_id: "task_sm_1" }));
    store.transition("task_sm_1", "running", { worker_pid: 42 });
    expect(store.getTask("task_sm_1")?.worker_pid).toBe(42);
    expect(store.getTask("task_sm_1")?.started_at).not.toBeNull();
    store.transition("task_sm_1", "done", { summary: "Selesai.", artifact_dir: "data/artifacts/x" });
    const done = store.getTask("task_sm_1");
    expect(done?.status).toBe("done");
    expect(done?.summary).toBe("Selesai.");
    expect(done?.finished_at).not.toBeNull();

    const store2 = new TaskStore({ dbPath: dbPath("sm2") });
    store2.createTask(makeTask({ task_id: "task_sm_2" }));
    store2.transition("task_sm_2", "running");
    store2.transition("task_sm_2", "blocked");
    expect(store2.getTask("task_sm_2")?.status).toBe("blocked");
    store2.transition("task_sm_2", "running");
    store2.transition("task_sm_2", "cancelled");
    expect(store2.getTask("task_sm_2")?.status).toBe("cancelled");

    const store3 = new TaskStore({ dbPath: dbPath("sm3") });
    store3.createTask(makeTask({ task_id: "task_sm_3" }));
    store3.transition("task_sm_3", "cancelled");
    expect(store3.getTask("task_sm_3")?.status).toBe("cancelled");
  });

  it("transisi invalid (done→running) → INVALID_TRANSITION, tidak silent-allow", () => {
    const store = new TaskStore({ dbPath: dbPath("inv") });
    store.createTask(makeTask({ task_id: "task_inv_1" }));
    store.transition("task_inv_1", "running");
    store.transition("task_inv_1", "done", { summary: "ok" });
    expect(() => store.transition("task_inv_1", "running")).toThrowError("tidak diizinkan");
    expectCode(() => store.transition("task_inv_1", "running"), "INVALID_TRANSITION");
    // state tidak berubah
    expect(store.getTask("task_inv_1")?.status).toBe("done");
    store.close();
  });
});

describe("WAL + busy_timeout (TASK-1.4)", () => {
  it("journal_mode=wal dan busy_timeout=5000 (PRAGMA terbukti)", () => {
    const path = dbPath("wal");
    const store = new TaskStore({ dbPath: path });
    expect(store.journalMode()).toBe("wal");
    expect(store.busyTimeout()).toBe(5000);
    store.close();
  });

  it("write+read dalam satu transaksi → konsisten", () => {
    const path = dbPath("txn");
    const store = new TaskStore({ dbPath: path });
    store.createTask(makeTask({ task_id: "task_txn_1" }));
    const before = store.getTask("task_txn_1")?.status;
    // simulate transaksi atomik via better-sqlite3 langsung (single-writer)
    const raw = new Database(path);
    raw.pragma("busy_timeout = 5000");
    raw.exec("BEGIN IMMEDIATE");
    raw.prepare("UPDATE tasks SET status = 'running' WHERE task_id = 'task_txn_1'").run();
    const inside = raw.prepare("SELECT status FROM tasks WHERE task_id = 'task_txn_1'").get();
    raw.exec("COMMIT");
    raw.close();
    expect(before).toBe("queued");
    expect((inside as { status: string }).status).toBe("running");
    expect(store.getTask("task_txn_1")?.status).toBe("running");
    store.close();
  });

  it("dua proses tulis bareng → menunggu lalu error yang jelas (tidak corrupt)", () => {
    const path = dbPath("busy");
    const storeA = new TaskStore({ dbPath: path });
    storeA.createTask(makeTask({ task_id: "task_busy_1" }));
    const connA = new Database(path);
    connA.pragma("busy_timeout = 5000");
    connA.exec("BEGIN IMMEDIATE"); // kunci tulis dipegang
    const connB = new Database(path);
    connB.pragma("busy_timeout = 200"); // tunggu singkat lalu error
    expect(() => {
      connB.prepare("UPDATE tasks SET status='running' WHERE task_id='task_busy_1'").run();
    }).toThrowError(/busy|locked/i);
    connA.exec("ROLLBACK");
    connA.close();
    connB.close();
    // tidak corrupt
    expect(storeA.integrityCheck()).toBe("ok");
    storeA.close();
  });
});

describe("checkTaskStatus (voice-optimized, golden fixture)", () => {
  it("fixture 3 task → narratable ≤ 5 baris & counts benar; unknown → not_found tanpa throw", () => {
    const store = new TaskStore({ dbPath: dbPath("fixture") });
    const fixture = JSON.parse(readFileSync(new URL(FIXTURE_JSON, import.meta.url), "utf8"));
    for (const task of fixture.tasks) store.createTask(task);

    const result = store.checkTaskStatus(["task_fe_01", "task_fe_02", "task_fe_03", "task_unknown"]);
    expect(result.narratable.length).toBeLessThanOrEqual(5);
    expect(result.counts).toMatchObject({ queued: 1, done: 1, failed: 1, not_found: 1, total: 4 });
    expect(result.tasks.task_fe_01?.status).toBe("queued");
    expect(result.tasks.task_fe_02?.status).toBe("done");
    expect(result.tasks.task_unknown).toEqual({ status: "not_found" });

    const active = store.checkTaskStatus("active");
    expect(active.narratable.length).toBeLessThanOrEqual(5);
    expect(active.counts.queued).toBe(1);
    expect(active.counts.running).toBe(0);
    store.close();
  });

  it("narratable di-cap 5 baris walau > 5 task (baris terakhir rangkuman)", () => {
    const store = new TaskStore({ dbPath: dbPath("cap") });
    for (let i = 0; i < 7; i++) {
      store.createTask(makeTask({ task_id: `task_cap_${i}` }));
    }
    const result = store.checkTaskStatus("active");
    expect(result.narratable.length).toBe(5);
    expect(result.narratable[4]).toContain("dan 3 task lainnya");
    expect(result.counts.queued).toBe(7);
    store.close();
  });
});

describe("heartbeat & stale detection (fake timer)", () => {
  it("touchHeartbeat update liveness; staleTasks(ttl) → failed/STALE_HEARTBEAT", () => {
    let t = 1_700_000_000_000;
    const store = new TaskStore({ dbPath: dbPath("stale"), now: () => t });
    store.createTask(makeTask({ task_id: "task_hb_1" }));
    store.transition("task_hb_1", "running");
    expect(store.touchHeartbeat("task_hb_1").ok).toBe(true);
    expect(store.touchHeartbeat("task_hb_1").record?.heartbeat_ts).toBe(t);
    // heartbeat tidak ada → NOT_FOUND; status bukan running → NOT_RUNNING
    expect(store.touchHeartbeat("task_hb_none").code).toBe("NOT_FOUND");
    store.transition("task_hb_1", "done", { summary: "ok" });
    expect(store.touchHeartbeat("task_hb_1").code).toBe("NOT_RUNNING");

    // task running lain dengan heartbeat basi
    store.createTask(makeTask({ task_id: "task_hb_2" }));
    store.transition("task_hb_2", "running");
    expect(store.touchHeartbeat("task_hb_2").ok).toBe(true);
    t += 61_000; // lewat 60s — stale
    const marked = store.staleTasks(60);
    expect(marked.map((r) => r.task_id)).toContain("task_hb_2");
    expect(marked.find((r) => r.task_id === "task_hb_2")?.error).toBe("STALE_HEARTBEAT");
    expect(store.getTask("task_hb_2")?.status).toBe("failed");
    // yang baru di-touch tidak di-mark
    t += 1_000;
    expect(store.staleTasks(60)).toHaveLength(0);
    store.close();
  });
});

describe("DB survive restart + integrity", () => {
  it("tulis 5 task → close → buka ulang → semua masih ada; integrity_check=ok", () => {
    const path = dbPath("restart");
    const store1 = new TaskStore({ dbPath: path });
    for (let i = 0; i < 5; i++) {
      store1.createTask(makeTask({ task_id: `task_r_${i}` }));
    }
    store1.close();
    const store2 = new TaskStore({ dbPath: path });
    expect(store2.listTasks()).toHaveLength(5);
    expect(store2.getTask("task_r_3")?.task_id).toBe("task_r_3");
    expect(store2.journalMode()).toBe("wal");
    expect(store2.integrityCheck()).toBe("ok");
    store2.close();
  });
});

describe("artifact > 1KB di filesystem, DB hanya path", () => {
  it("konten > 1KB tersimpan di file; row DB tidak memuat isinya (hanya artifact_dir)", () => {
    const base = tmp();
    const path = join(base, "art.db");
    const store = new TaskStore({ dbPath: path });
    store.createTask(makeTask({ task_id: "task_art_1" }));

    const bigContent = `# diff\n${"x".repeat(5000)}\n`;
    expect(Buffer.byteLength(bigContent)).toBeGreaterThan(1024);
    const { artifactDir, filePath } = store.storeArtifactContent(
      "task_art_1",
      join(base, "artifacts"),
      "diff.patch",
      bigContent,
    );
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(bigContent);
    expect(store.getTask("task_art_1")?.artifact_dir).toBe(artifactDir);

    // buktikan DB TIDAK memuat isi artifact: dump row mentah
    const raw = new Database(path);
    const row = raw.prepare("SELECT * FROM tasks WHERE task_id='task_art_1'").get() as Record<string, unknown>;
    raw.close();
    expect(JSON.stringify(row)).not.toContain("xxxxxx");
    expect(String(row.artifact_dir)).toContain("task_art_1");
    store.close();
  });
});

describe("summary ≤ 200 kata — enforce di layer API", () => {
  it("summary > 200 kata → SUMMARY_TOO_LONG (create & transition done)", () => {
    const store = new TaskStore({ dbPath: dbPath("sum") });
    store.createTask(makeTask({ task_id: "task_sum_1" }));
    store.transition("task_sum_1", "running");
    const longSummary = oneLine(201);
    expectCode(
      () => store.createTask(makeTask({ task_id: "task_sum_2", summary: longSummary })),
      "SUMMARY_TOO_LONG",
    );
    expectCode(() => store.completeTask("task_sum_1", { summary: longSummary }), "SUMMARY_TOO_LONG");
    // 200 kata → OK
    const ok = store.completeTask("task_sum_1", { summary: oneLine(200) });
    expect(ok.status).toBe("done");
    expect(countWords(ok.summary)).toBe(200);
    store.close();
  });
});