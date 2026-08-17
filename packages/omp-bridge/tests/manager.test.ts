/**
 * Unit test worker manager (TASK-2.2) — spawn/kill/retry/timeout/heartbeat.
 *
 * Bukti acceptance:
 * - pool TIDAK pernah > 3 running (mock runner, counter concurrency maks = 3)
 * - antrean FIFO benar (urutan dispatch = urutan spawn)
 * - timeout: mock worker sleep 10s, timeout 1s → failed/TIMEOUT < 2s
 *   (bridge nyata, kill terbukti), slot kembali tersedia
 * - retry count naik sesuai policy (TIMEOUT → retry backoff → failed)
 * - recoverStale: 2 task running basi → failed/STALE_HEARTBEAT
 * - idempotensi: worker selesai tapi report hilang → done TANPA re-execution
 *   (spawn count tidak bertambah)
 * - zombie (kill gagal) → Pid tercatat, failed + alert, slot tidak terblokir
 * - heartbeat: touchHeartbeat oleh manager (single-writer) ≤ interval
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "task-store";
import type { TaskSpec } from "handoff-contract";
import { OwnershipMap } from "conflict-map";
import { WorkerManager, type WorkerManagerEvent, type RunnerImpl, type WorkerManagerOptions } from "../src/manager.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-wm-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(dir: string): string {
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "lib", "math.py"), "def add(a: int, b: int) -> int:\n    return a - b\n");
  writeFileSync(join(dir, "tests", "test_math.py"), "from lib.math import add\n\ndef test_add():\n    assert add(2, 3) == 5\n");
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "unit"]);
  git(["config", "user.email", "u@local"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return dir;
}

const SPEC: TaskSpec = {
  task_id: "t",
  lane: "debug",
  objective: "fix bug: fungsi add salah return",
  files_owned: ["lib/math.py"],
  requirements: ["add(2,3) harus 5"],
  acceptance_criteria: ["pytest hijau"],
  boundaries: ["hanya ubah lib/math.py"],
  verification_steps: ["true"],
};

/** Empat helper: events collect via opts.onEvent. */
function makeManager(base: string, extra: Partial<WorkerManagerOptions>): { store: TaskStore; repo: string; mgr: WorkerManager; evts: WorkerManagerEvent[] } {
  const store = new TaskStore({ dbPath: join(base, "tasks.db") });
  const repo = makeRepo(join(base, "repo"));
  const evts: WorkerManagerEvent[] = [];
  const mgr = new WorkerManager({
    store,
    allowlist: [repo],
    artifactDirBase: join(base, "artifacts"),
    mockMarkerDir: join(base, "spawns"),
    onWorkerReady: (id) => {
      store.transition(id, "done", { summary: "worker ok (stub orchestrator)" });
    },
    onEvent: (e) => evts.push(e),
    ...extra,
  });
  return { store, repo, mgr, evts };
}

describe("WorkerManager — pool & FIFO (TASK-2.2)", () => {
  it("pool TIDAK pernah > 3 running (hard cap) + antrean FIFO benar", async () => {
    const base = tmp();
    let cur = 0;
    let maxCur = 0;
    const dispatchOrder: string[] = [];
    const runner: RunnerImpl = async (spec) => {
      cur += 1;
      maxCur = Math.max(maxCur, cur);
      dispatchOrder.push(spec.task_id);
      await new Promise((r) => setTimeout(r, 40));
      cur -= 1;
      return { status: "ok", exitCode: 0, stdoutTail: "ok", diffSummary: "(none)", diffFull: "", worktree: "" };
    };
    const { store, repo, mgr } = makeManager(base, { runner });
    for (let i = 1; i <= 5; i++) {
      store.createTask({ task_id: `t${i}`, lane: "debug" });
      const r = await mgr.spawnTask(`t${i}`, repo, { spec: { ...SPEC, task_id: `t${i}` } });
      if (i <= 3) expect(r.status).toBe("running");
      else expect(r.status).toBe("queued"); // pool penuh → FIFO
    }
    await mgr.drain();
    expect(maxCur).toBeLessThanOrEqual(3);
    expect(maxCur).toBe(3); // pool terisi penuh sesuai cap
    expect(dispatchOrder).toEqual(["t1", "t2", "t3", "t4", "t5"]); // FIFO murni
    for (let i = 1; i <= 5; i++) {
      expect(store.getTask(`t${i}`)!.status).toBe("done");
    }
  });

  it("pool penuh → task ke-4/5 tetap queued sampai slot kosong", async () => {
    const base = tmp();
    const { store, repo, mgr } = makeManager(base, {
      runner: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
      },
    });
    for (let i = 1; i <= 5; i++) store.createTask({ task_id: `t${i}`, lane: "debug" });
    for (let i = 1; i <= 5; i++) await mgr.spawnTask(`t${i}`, repo, { spec: { ...SPEC, task_id: `t${i}` } });
    expect(mgr.runningCount()).toBe(3);
    expect(mgr.queuedCount()).toBe(2);
    expect(store.getTask("t4")!.status).toBe("queued");
    expect(store.getTask("t5")!.status).toBe("queued");
    await mgr.drain();
    expect(mgr.runningCount()).toBe(0);
    expect(mgr.queuedCount()).toBe(0);
  });
});

describe("WorkerManager — timeout & retry", () => {
  it("mock worker sleep 10s, timeout 1s → failed/TIMEOUT < 2s (bridge nyata, kill SIGKILL)", async () => {
    const base = tmp();
    const { store, repo, mgr } = makeManager(base, {
      defaultTimeoutMs: 1000,
      maxRetries: 0, // 1 attempt → ukur kill-time
    });
    const started = Date.now();
    store.createTask({ task_id: "t_slow", lane: "debug" });
    const r = await mgr.spawnTask("t_slow", repo, {
      spec: { ...SPEC, task_id: "t_slow" },
      mock: true,
      env: { OMP_BRIDGE_MOCK_SLEEP_MS: "10000" }, // mock worker tidur 10 detik
    });
    expect(r.status).toBe("running");
    await mgr.drain();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000); // di-kill segera, bukan menunggu 10s
    const rec = store.getTask("t_slow")!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("TIMEOUT");
    expect(mgr.runningCount()).toBe(0); // slot kembali tersedia
    expect(mgr.spawnCount).toBe(1); // 1 attempt (tanpa retry)
  });

  it("retry count naik sesuai policy (2 retry backoff) → failed TIMEOUT (3 attempts)", async () => {
    const base = tmp();
    const { store, repo, mgr, evts } = makeManager(base, {
      maxRetries: 2,
      retryBackoffMs: [10, 15],
      runner: async () => ({ status: "error", code: "TIMEOUT", message: "mock timeout", pid: 4242 }),
    });
    store.createTask({ task_id: "t_retry", lane: "debug" });
    await mgr.spawnTask("t_retry", repo, { spec: { ...SPEC, task_id: "t_retry" } });
    await mgr.drain();
    const retries = evts.filter((e) => e.type === "retry") as Array<WorkerManagerEvent & { backoffMs: number }>;
    expect(retries.map((e) => e.backoffMs)).toEqual([10, 15]); // backoff sesuai policy
    expect(evts.filter((e) => e.type === "dispatch")).toHaveLength(3); // 1 awal + 2 retry
    expect(mgr.spawnCount).toBe(3);
    const rec = store.getTask("t_retry")!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("TIMEOUT (3 attempts)");
  });
});

describe("WorkerManager — recovery stale & heartbeat", () => {
  it("recoverStale: 2 task running basi → failed/STALE_HEARTBEAT (saat manager restart)", async () => {
    const base = tmp();
    const store = new TaskStore({ dbPath: join(base, "tasks.db") });
    const now = Date.now();
    store.createTask({ task_id: "stale1", status: "running", heartbeat_ts: now - 120_000, started_at: now - 120_000 });
    store.createTask({ task_id: "stale2", status: "running", heartbeat_ts: now - 120_000, started_at: now - 120_000 });
    store.createTask({ task_id: "fresh1", status: "running", heartbeat_ts: now - 10_000 });

    const evts: WorkerManagerEvent[] = [];
    const mgr = new WorkerManager({
      store,
      allowlist: ["/tmp/xyz"],
      staleTtlSeconds: 60,
      onEvent: (e) => evts.push(e),
    });
    const { recovered } = await mgr.start();
    expect(recovered.sort()).toEqual(["stale1", "stale2"]);
    expect(store.getTask("stale1")!.status).toBe("failed");
    expect(store.getTask("stale1")!.error).toBe("STALE_HEARTBEAT");
    expect(store.getTask("stale2")!.status).toBe("failed");
    expect(store.getTask("stale2")!.error).toBe("STALE_HEARTBEAT");
    expect(store.getTask("fresh1")!.status).toBe("running"); // tidak tersentuh
    expect(evts.filter((e) => e.type === "recovered-stale")).toHaveLength(2);
    mgr.stop();
  });

  it("heartbeat: manager (single-writer) touchHeartbeat ≤ interval → heartbeat_ts maju", async () => {
    const base = tmp();
    const { store, repo, mgr } = makeManager(base, {
      heartbeatIntervalMs: 60,
      runner: async () => {
        await new Promise((r) => setTimeout(r, 350));
        return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
      },
    });
    await mgr.start();
    const before = Date.now();
    store.createTask({ task_id: "t_hb", lane: "debug" });
    await mgr.spawnTask("t_hb", repo, { spec: { ...SPEC, task_id: "t_hb" } });
    await mgr.drain();
    const rec = store.getTask("t_hb")!;
    expect(rec.heartbeat_ts).not.toBeNull();
    expect(rec.heartbeat_ts!).toBeGreaterThanOrEqual(before - 1000); // di-touch selama running
    expect(rec.status).toBe("done");
    mgr.stop();
  });
});

describe("WorkerManager — idempotensi & zombie", () => {
  it("idempotensi: worker selesai tapi report hilang → re-dispatch = done TANPA re-run (spawn count tetap)", async () => {
    const base = tmp();
    const { store, repo, mgr } = makeManager(base, {
      verifierCmd: "true", // test suite repo hijau (perubahan sudah landing)
      runner: async () => {
        throw new Error("TIDAK boleh di-spawn ulang — task sudah landing");
      },
      onWorkerReady: () => {
        throw new Error("onWorkerReady tidak boleh dipanggil");
      },
    });
    // simulasikan: perubahan SUDAH landing di main repo + artifact diff ada,
    // tapi status task masih running (report/done hilang)
    writeFileSync(join(repo, "lib", "math.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "-c", "user.name=u", "-c", "user.email=u@l", "commit", "-qm", "landed"], { stdio: "pipe" });
    store.createTask({ task_id: "t_landed", status: "running", lane: "debug" });
    store.storeArtifactContent("t_landed", join(base, "artifacts"), "diff.patch", "diff --git a/lib/math.py b/lib/math.py\n+return a + b\n");
    store.storeArtifactContent("t_landed", join(base, "artifacts"), "diff-stat.txt", "1 file changed");

    const r = await mgr.spawnTask("t_landed", repo, { spec: { ...SPEC, task_id: "t_landed" } });
    expect(r.status).toBe("terminal");
    const rec = store.getTask("t_landed")!;
    expect(rec.status).toBe("done");
    expect(rec.error).toBe("idempotent: work landed sebelum report hilang");
    expect(mgr.spawnCount).toBe(0); // TIDAK ada re-execution
  });

  it("idempotensi negatif: diff kosong → belum landing → dispatch normal", async () => {
    const base = tmp();
    let spawned = 0;
    const { store, repo, mgr } = makeManager(base, {
      runner: async () => {
        spawned += 1;
        return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
      },
    });
    store.createTask({ task_id: "t_nochange", status: "running", lane: "debug" });
    store.storeArtifactContent("t_nochange", join(base, "artifacts"), "diff.patch", "");
    await mgr.spawnTask("t_nochange", repo, { spec: { ...SPEC, task_id: "t_nochange" } });
    await mgr.drain();
    expect(spawned).toBe(1);
    expect(store.getTask("t_nochange")!.status).toBe("done");
  });

  it("zombie: kill gagal → failed/ZOMBIE_KILL_FAILED + Pid tercatat + alert + slot TIDAK terblokir", async () => {
    const base = tmp();
    let callCount = 0;
    const { store, repo, mgr, evts } = makeManager(base, {
      runner: async () => {
        callCount += 1;
        if (callCount === 1) {
          // First call (z1): return TIMEOUT
          return { status: "error", code: "TIMEOUT", message: "timeout", pid: 777 };
        }
        // Second call (z2): succeed
        return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
      },
      killWorker: () => false, // kill GAGAL → zombie
    });
    store.createTask({ task_id: "z1", lane: "debug" });
    store.createTask({ task_id: "z2", lane: "debug" });
    await mgr.spawnTask("z1", repo, { spec: { ...SPEC, task_id: "z1" } });
    await mgr.spawnTask("z2", repo, { spec: { ...SPEC, task_id: "z2" } });
    await mgr.drain();

    const z1 = store.getTask("z1")!;
    expect(z1.status).toBe("failed");
    expect(z1.error).toBe("ZOMBIE_KILL_FAILED (pid 777)");
    expect(z1.worker_pid).toBe(777); // Pid TERCATAT di store
    // slot tidak terblokir: z2 tetap jalan (worker-ok → done) meski z1 zombie
    expect(store.getTask("z2")!.status).toBe("done");
    expect(mgr.runningCount()).toBe(0);
    expect(evts.some((e) => e.type === "alert" && e.message?.includes("zombie-worker") && e.message.includes("pid=777"))).toBe(true);
  });
});

describe("WorkerManager — pre-spawn ownership hook (TASK-2.3 dependency)", () => {
  it("overlap task 2 → tetap queued sampai owner selesai; force → ditolak CONFLICT_DETECTED", async () => {
    const base = tmp();
    let t1Running = false;
    const runnerCalls: string[] = [];
    
    const { store, repo, mgr, evts } = makeManager(base, {
      runner: async (spec) => {
        runnerCalls.push(spec.task_id);
        if (spec.task_id === "t1") {
          t1Running = true;
          // Let t1 run for a bit, then complete
          await new Promise((r) => setTimeout(r, 50));
        }
        return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
      },
      ownership: {
        conflictsWith: (taskId: string): string[] => {
          const shared = ["lib/math.py"];
          const owners: string[] = [];
          for (const other of ["t1", "t2"]) {
            if (other === taskId) continue;
            const active = store.getTask(other);
            if (active && active.status === "running") {
              if (shared.length > 0) owners.push(other);
            }
          }
          return owners;
        },
      },
    });

    store.createTask({ task_id: "t1", lane: "debug" });
    store.createTask({ task_id: "t2", lane: "debug" });
    await mgr.spawnTask("t1", repo, { spec: { ...SPEC, task_id: "t1" } });
    await mgr.spawnTask("t2", repo, { spec: { ...SPEC, task_id: "t2" } });
    // Small delay to let transitions propagate and pump run
    await new Promise((r) => setTimeout(r, 50));
    
    // t1 should be running, t2 should be queued (deferred)
    expect(mgr.runningCount()).toBe(1);
    expect(mgr.queuedCount()).toBe(1);
    expect(evts.some((e) => e.type === "conflict-deferred" && e.taskId === "t2" && e.owners?.includes("t1"))).toBe(true);

    // user memaksa spawn bentrok → TOLAK CONFLICT_DETECTED + daftar pemilik
    const forced = await mgr.spawnTask("t2", repo, { spec: { ...SPEC, task_id: "t2" }, force: true });
    expect(forced.status).toBe("rejected");
    expect(forced.reason).toBe("CONFLICT_DETECTED");
    expect(forced.owners).toEqual(["t1"]);

    // Wait for both tasks to complete
    await mgr.drain();
    expect(store.getTask("t1")!.status).toBe("done");
    expect(store.getTask("t2")!.status).toBe("done");
    expect(runnerCalls).toEqual(["t1", "t2"]); // t1 ran first, then t2
  });
});

describe("WorkerManager × OwnershipMap — pre-spawn integrasi (TASK-2.3)", () => {
  it("task overlap ter-defer sampai owner release (OwnershipMap nyata + release via onTaskTerminal)", async () => {
    const base = tmp();
    const store = new TaskStore({ dbPath: join(base, "tasks.db") });
    const repo = makeRepo(join(base, "repo"));
    const evts: WorkerManagerEvent[] = [];

    // OwnershipMap NYATA: aktif hanya bila task running di store
    const own = new OwnershipMap({ isActive: (id) => store.getTask(id)?.status === "running" });

    const mgr = new WorkerManager({
      store,
      allowlist: [repo],
      artifactDirBase: join(base, "artifacts"),
      mockMarkerDir: join(base, "spawns"),
      ownership: own,
      onWorkerReady: (id) => {
        store.transition(id, "done", { summary: "worker ok (stub orchestrator)" });
      },
      onTaskTerminal: (id) => {
        own.release(id); // release saat task terminal → owner bebas
      },
      runner: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "ok", exitCode: 0, stdoutTail: "", diffSummary: "", diffFull: "", worktree: "" };
      },
      onEvent: (e) => evts.push(e),
    });

    store.createTask({ task_id: "o1", lane: "debug" });
    store.createTask({ task_id: "o2", lane: "debug" });
    expect(own.claimFiles("o1", ["lib/math.py"])).toEqual({ status: "ok" });
    expect(own.claimFiles("o2", ["lib/math.py"])).toEqual({ status: "conflict", conflictsWith: ["o1"] });

    await mgr.spawnTask("o1", repo, { spec: { ...SPEC, task_id: "o1" } });
    await mgr.spawnTask("o2", repo, { spec: { ...SPEC, task_id: "o2" } });
    expect(mgr.queuedCount()).toBe(1); // o2 menunggu owner (o1) selesai
    expect(evts.some((e) => e.type === "conflict-deferred" && e.taskId === "o2" && e.owners?.includes("o1"))).toBe(true);

    await mgr.drain();
    expect(store.getTask("o1")!.status).toBe("done");
    expect(store.getTask("o2")!.status).toBe("done");
    // counter & log deteksi tercatat di ownership map
    expect(own.conflictCount()).toBeGreaterThanOrEqual(1);
    expect(own.conflictLog()[0]).toContain("conflict-detected");
  });
});