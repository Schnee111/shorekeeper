/**
 * tests/edge — TASK-3.2 requirement 4 & 5: race/duplikasi + restart orchestrator.
 *
 * Bukti acceptance:
 * - delegate ganda task_id sama → store 1 task, spawn count 1 (mock).
 * - restart: seed `running` basi → recoverStale → failed/STALE_HEARTBEAT,
 *   data lain utuh (tidak ada task "hilang").
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "task-store";
import type { TaskSpec } from "handoff-contract";
import { WorkerManager, type RunnerImpl } from "../../src/manager.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-edge-dup-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(dir: string): string {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "math.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "edge"]);
  git(["config", "user.email", "edge@local"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return dir;
}

const SPEC: TaskSpec = {
  task_id: "dup1",
  lane: "debug",
  objective: "fix bug: fungsi add",
  files_owned: ["lib/math.py"],
  requirements: [],
  acceptance_criteria: ["ok"],
  boundaries: [],
  verification_steps: ["true"],
};

describe("edge: race/duplikasi delegate (TASK-3.2)", () => {
  it("dua call delegate_task task_id sama → store 1 task, spawn count 1 (idempotent)", async () => {
    const base = tmp();
    const store = new TaskStore({ dbPath: join(base, "tasks.db") });
    const repo = makeRepo(join(base, "repo"));
    let runnerCalls = 0;
    const runner: RunnerImpl = async () => {
      runnerCalls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
    };
    const mgr = new WorkerManager({
      store,
      allowlist: [repo],
      runner,
      onWorkerReady: (id) => {
        store.transition(id, "done", { summary: "ok (stub merge gate)" });
      },
    });

    store.createTask({ task_id: "dup1", lane: "debug" });
    // dua call delegate (retry ganda dari front) — SEBELUM drain
    const r1 = await mgr.spawnTask("dup1", repo, { spec: SPEC });
    const r2 = await mgr.spawnTask("dup1", repo, { spec: SPEC });
    expect(r1.status).toBe("running");
    expect(r2.status).toBe("running"); // call kedua melihat sudah running, bukan queued/dobel

    await mgr.drain();
    expect(runnerCalls).toBe(1); // tidak dobel spawn
    expect(mgr.spawnCount).toBe(1);
    // store tetap 1 task (single-writer menjaga konsistensi)
    expect(store.listTasks().length).toBe(1);
    expect(store.getTask("dup1")!.status).toBe("done");
    store.close();
  });

  it("spawnTask untuk task yang SUDAH done → terminal, tanpa re-spawn", async () => {
    const base = tmp();
    const store = new TaskStore({ dbPath: join(base, "tasks.db") });
    const repo = makeRepo(join(base, "repo"));
    let runnerCalls = 0;
    const runner: RunnerImpl = async () => {
      runnerCalls += 1;
      return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
    };
    const mgr = new WorkerManager({
      store,
      allowlist: [repo],
      runner,
      onWorkerReady: (id) => {
        store.transition(id, "done", { summary: "ok" });
      },
    });
    store.createTask({ task_id: "dup2", lane: "debug" });
    await mgr.spawnTask("dup2", repo, { spec: { ...SPEC, task_id: "dup2" } });
    await mgr.drain();
    expect(runnerCalls).toBe(1);
    // delegate ulang setelah done (retry ganda yang datang terlambat)
    const r = await mgr.spawnTask("dup2", repo, { spec: { ...SPEC, task_id: "dup2" } });
    expect(r.status).toBe("terminal");
    expect(runnerCalls).toBe(1); // tetap 1
    store.close();
  });
});

describe("edge: restart orchestrator (TASK-3.2)", () => {
  it("kill saat running → restart → recoverStale → failed/STALE_HEARTBEAT; data lain utuh", async () => {
    const base = tmp();
    let now = 1_000_000;
    const store = new TaskStore({ dbPath: join(base, "tasks.db"), now: () => now });
    const repo = makeRepo(join(base, "repo"));
    const runner: RunnerImpl = async () => ({
      status: "ok",
      exitCode: 0,
      stdoutTail: "",
      diffSummary: "",
      diffFull: "",
      worktree: "",
    });

    // Simulasi proses lama: task running dengan heartbeat, lalu "mati" (waktu maju).
    store.createTask({ task_id: "stale1", lane: "debug" });
    store.transition("stale1", "running", { worker_pid: 111 });
    store.createTask({ task_id: "fresh1", lane: "qa" }); // queued — tidak boleh terganggu
    store.createTask({ task_id: "done1", lane: "debug" });
    store.transition("done1", "running");
    store.transition("done1", "done", { summary: "selesai" });
    now += 120_000; // 120 detik kemudian: heartbeat stale1 basi (TTL 60s)

    // "Restart" orchestrator: manager baru dengan store yang sama.
    const mgr = new WorkerManager({
      store,
      allowlist: [repo],
      runner,
      staleTtlSeconds: 60,
    });
    const { recovered } = await mgr.start();
    expect(recovered).toContain("stale1");

    const stale = store.getTask("stale1")!;
    expect(stale.status).toBe("failed");
    expect(stale.error).toBe("STALE_HEARTBEAT");
    // data lain utuh — tidak ada task "hilang"
    expect(store.getTask("fresh1")!.status).toBe("queued");
    expect(store.getTask("done1")!.status).toBe("done");
    expect(store.getTask("done1")!.summary).toBe("selesai");
    expect(store.listTasks().length).toBe(3);
    mgr.stop();
    store.close();
  });

  it("recoverStale idempotent: restart kedua tidak mengubah apa pun", async () => {
    const base = tmp();
    let now = 2_000_000;
    const store = new TaskStore({ dbPath: join(base, "tasks.db"), now: () => now });
    const repo = makeRepo(join(base, "repo"));
    const runner: RunnerImpl = async () => ({
      status: "ok",
      exitCode: 0,
      stdoutTail: "",
      diffSummary: "",
      diffFull: "",
      worktree: "",
    });
    store.createTask({ task_id: "s2", lane: "debug" });
    store.transition("s2", "running");
    now += 120_000;
    const mgr = new WorkerManager({ store, allowlist: [repo], runner, staleTtlSeconds: 60 });
    const first = await mgr.start();
    expect(first.recovered).toEqual(["s2"]);
    // restart lagi (recoverStale eksplisit) → sudah tidak ada yang stale
    const second = await mgr.recoverStale();
    expect(second).toEqual([]);
    expect(store.getTask("s2")!.status).toBe("failed");
    mgr.stop();
    store.close();
  });
});
