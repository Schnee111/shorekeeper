/**
 * tests/edge — TASK-3.2 requirement 1: disconnect mid-task.
 *
 * Platform fact: koneksi user↔SFU dan agent↔model adalah dua link terpisah;
 * sesi voice bisa mati kapan saja. Task state WAJIB di luar sesi (SQLite).
 *
 * Our behavior:
 * - task `running` saat "client" menghilang → task TETAP jalan sampai selesai
 *   (orkestrasi tidak tergantung sesi); hasil masuk store + outbox notify.
 * - saat "reconnect" → drainNotify() menampilkan hasil yang belum di-deliver.
 * - dedupe: hasil sudah pernah di-deliver → TIDAK dikirim dua kali (flag
 *   delivered=1; drain kedua kosong). At-least-once + idempotency via stable
 *   task_id (PK outbox).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../../src/index.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-edge-dc-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("edge: disconnect mid-task + reconnect (TASK-3.2)", () => {
  it("client hilang saat running → task tetap selesai → reconnect drain 1×, delivered flag = 1", () => {
    const store = new TaskStore({ dbPath: join(tmp(), "tasks.db") });

    // 1. seed + running ("client" voice session aktif)
    store.createTask({ task_id: "dc1", lane: "debug" });
    store.transition("dc1", "running", { worker_pid: 4242 });

    // 2. SIMULASI DISCONNECT: client/consumer mati — orkestrasi tidak tahu &
    //    tidak peduli; task tetap jalan sampai selesai (single-writer store).
    store.transition("dc1", "done", { summary: "selesai saat client offline" });

    // 3. outbox terisi otomatis (hasil TIDAK hilang walau client mati)
    const state = store.notifyState("dc1");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("done");
    expect(state!.delivered).toBe(0); // belum ada yang deliver (client masih hilang)

    // 4. SIMULASI RECONNECT: front memanggil checkTaskStatus + drainNotify
    const status = store.checkTaskStatus(["dc1"]);
    expect(status.tasks["dc1"]!.status).toBe("done");
    expect(status.tasks["dc1"]!.summary).toBe("selesai saat client offline");

    const delivered = store.drainNotify();
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.task_id).toBe("dc1");
    expect(store.notifyState("dc1")!.delivered).toBe(1); // flag delivered = 1

    // 5. dedupe: hasil sudah pernah di-deliver → TIDAK dikirim dua kali
    expect(store.drainNotify().length).toBe(0);
    store.close();
  });

  it("task gagal saat offline → reconnect menerima notifikasi failed tepat sekali", () => {
    const store = new TaskStore({ dbPath: join(tmp(), "tasks.db") });
    store.createTask({ task_id: "dc2", lane: "debug" });
    store.transition("dc2", "running");
    store.transition("dc2", "failed", { error: "VERIFY_FAILED" });

    const delivered = store.drainNotify();
    expect(delivered.map((d) => `${d.task_id}:${d.status}`)).toEqual(["dc2:failed"]);
    expect(store.drainNotify()).toEqual([]); // tidak dobel
    store.close();
  });

  it("beberapa task selesai saat offline → reconnect menerima semuanya urut waktu", () => {
    const store = new TaskStore({ dbPath: join(tmp(), "tasks.db") });
    store.createTask({ task_id: "m1", lane: "debug", created_at: 1000 });
    store.createTask({ task_id: "m2", lane: "qa", created_at: 2000 });
    store.transition("m1", "running");
    store.transition("m2", "running");
    store.transition("m1", "done", { summary: "s1" });
    store.transition("m2", "done", { summary: "s2" });

    const delivered = store.drainNotify();
    expect(delivered.map((d) => d.task_id)).toEqual(["m1", "m2"]);
    store.close();
  });

  it("outbox idempotent per task_id (re-enqueue tidak mendobel baris)", () => {
    const store = new TaskStore({ dbPath: join(tmp(), "tasks.db") });
    store.notifyEnqueue("x1", "done");
    store.notifyEnqueue("x1", "done"); // duplikat (retry delivery)
    expect(store.drainNotify().length).toBe(1);
    store.close();
  });
});
