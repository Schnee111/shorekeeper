/**
 * Unit test merge orchestrator (TASK-2.1) — PEMEGANG TUNGGAL merge gate.
 *
 * Bukti:
 * - 2 branch worker tipikal → squash merge sukses SEQUENTIAL, `main` berisi
 *   gabungan (isi file dicek), merge_commit ≥ 7 char tercatat (artifact
 *   merge.json + summary store), task `done`.
 * - Verifier MERAH → merge DITOLAK, task `blocked` error=VERIFY_FAILED,
 *   main tidak berubah, branch worker dipertahankan.
 * - Tanpa flag approval → remote TIDAK menerima push (fixture remote kosong),
 *   branch lokal `main-local` yang ter-update.
 * - Dengan flag approval → push sukses ke fixture remote lokal.
 * - Push ditolak terus → retry → task `failed` + instruksi manual.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "task-store";
import { MergeOrchestrator } from "../src/orchestrator.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-om-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function makeRepo(dir: string): string {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "math.py"), "def add(a: int, b: int) -> int:\n    return a - b\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["-c", "user.name=unit", "-c", "user.email=u@local", "add", "-A"]);
  git(dir, ["-c", "user.name=unit", "-c", "user.email=u@local", "commit", "-qm", "base"]);
  return dir;
}

/** Buat branch worker/<taskId> dengan 1 commit mengubah/menambah file (dari main). */
function makeWorkerBranch(repo: string, taskId: string, file: string, content: string): void {
  git(repo, ["checkout", "-q", "-b", `worker/${taskId}`, "main"]);
  writeFileSync(join(repo, file), content);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=worker", "-c", "user.email=w@local", "commit", "-qm", `worker: ${taskId}`]);
  git(repo, ["checkout", "-q", "main"]);
}

function makeStore(dbPath: string): TaskStore {
  return new TaskStore({ dbPath });
}

describe("MergeOrchestrator (TASK-2.1)", () => {
  it("2 branch worker → squash merge sequential sukses, main berisi gabungan, merge_commit ≥ 7 char tercatat", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const store = makeStore(join(base, "tasks.db"));
    const artifactBase = join(base, "artifacts");
    makeWorkerBranch(repo, "task_m1", "lib/feature.py", "def double(x):\n    return x * 2\n");
    makeWorkerBranch(repo, "task_m2", "lib/greet.py", "def greet():\n    return 'Hello'\n");
    store.createTask({ task_id: "task_m1", status: "running", lane: "debug" });
    store.createTask({ task_id: "task_m2", status: "running", lane: "frontend" });

    const orc = new MergeOrchestrator({
      store,
      verifierCmd: "true", // verifier read-only deterministik (test suite nyata di E2E)
      artifactDirBase: artifactBase,
      worktreeBase: join(base, "vt"),
    });
    const events: string[] = [];
    orc.emit = (e) => events.push(`${e.type}:${e.taskId}`);

    const r1 = await orc.mergeTask("task_m1", repo);
    expect(r1.status).toBe("merged");
    expect(r1.mergeCommit).toMatch(/^[0-9a-f]{40}$/);

    const r2 = await orc.mergeTask("task_m2", repo);
    expect(r2.status).toBe("merged");

    // main berisi GABUNGAN kedua branch
    expect(readFileSync(join(repo, "lib", "feature.py"), "utf8")).toContain("return x * 2");
    expect(readFileSync(join(repo, "lib", "greet.py"), "utf8")).toContain("'Hello'");

    // store: done + merge_commit (sha 7+) via artifact merge.json + summary
    const t1 = store.getTask("task_m1")!;
    expect(t1.status).toBe("done");
    expect(t1.summary).toMatch(/Squash merge: [0-9a-f]{7}\./);
    expect(t1.artifact_dir).toBe(join(artifactBase, "task_m1"));
    const mergeJson = JSON.parse(readFileSync(join(artifactBase, "task_m1", "merge.json"), "utf8")) as {
      merge_commit: string;
      merge_commit_short: string;
    };
    expect(mergeJson.merge_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(mergeJson.merge_commit_short.length).toBeGreaterThanOrEqual(7);
    expect(store.getTask("task_m2")!.status).toBe("done");

    // sequential: hanya 1 commit squash per task di main, branch worker dibersihkan
    const count = git(repo, ["rev-list", "--count", "HEAD~2..HEAD"]).trim();
    expect(count).toBe("2");
    expect(git(repo, ["branch", "--list", "worker/*"]).trim()).toBe("");
    // main-local ikut ter-update (default tanpa approval)
    expect(git(repo, ["rev-parse", "main-local"]).trim()).toBe(git(repo, ["rev-parse", "main"]).trim());
    // merge tidak pernah paralel
    expect(orc.inFlight()).toBe(0);
    expect(events.filter((e) => e.startsWith("merged:"))).toHaveLength(2);
  });

  it("verifier MERAH → merge DITOLAK, task blocked error=VERIFY_FAILED, main TIDAK berubah", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const store = makeStore(join(base, "tasks.db"));
    const artifactBase = join(base, "artifacts");
    makeWorkerBranch(repo, "task_red", "lib/feature.py", "def broken():\n    return 1\n");
    store.createTask({ task_id: "task_red", status: "running", lane: "debug" });

    const orc = new MergeOrchestrator({
      store,
      verifierCmd: "exit 1", // verifier merah
      artifactDirBase: artifactBase,
      worktreeBase: join(base, "vt"),
    });

    const r = await orc.mergeTask("task_red", repo);
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("VERIFY_FAILED");

    const t = store.getTask("task_red")!;
    expect(t.status).toBe("blocked");
    expect(t.error).toBe("VERIFY_FAILED");

    // main tidak berubah & branch worker dipertahankan (tidak di-force-merge)
    expect(git(repo, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(git(repo, ["branch", "--list", "worker/task_red"]).trim()).toBe("worker/task_red");
    // tidak ada merge_commit tercatat
    expect(existsSync(join(artifactBase, "task_red", "merge.json"))).toBe(false);
  });

  it("tanpa approval → remote TIDAK menerima push (tetap kosong), main-local yang maju", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    makeWorkerBranch(repo, "task_nopush", "notes.txt", "perubahan lokal\n");
    {
      const store = makeStore(join(base, "tasks.db"));
      store.createTask({ task_id: "task_nopush", status: "running", lane: "debug" });
      const orc = new MergeOrchestrator({
        store,
        verifierCmd: "true",
        artifactDirBase: join(base, "artifacts"),
        worktreeBase: join(base, "vt"),
        approvalGranted: false, // ← default
        remoteUrl: remote,
      });
      const r = await orc.mergeTask("task_nopush", repo);
      expect(r.status).toBe("merged");
      store.close();
    }
    // remote TIDAK menerima push: refs/heads/main tidak ada (unborn) → git exit non-0
    let remoteUnborn = false;
    try {
      execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", "refs/heads/main"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      remoteUnborn = true; // ref tidak ada = remote tetap kosong
    }
    expect(remoteUnborn).toBe(true);
    // main-local lokal = main (siap di-review manusia)
    expect(git(repo, ["rev-parse", "main-local"]).trim()).toBe(git(repo, ["rev-parse", "main"]).trim());
  });

  it("dengan flag approval → push sukses ke fixture remote lokal; sha remote = sha main", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    makeWorkerBranch(repo, "task_push", "notes.txt", "perubahan dengan approval\n");
    const store = makeStore(join(base, "tasks.db"));
    store.createTask({ task_id: "task_push", status: "running", lane: "debug" });
    const orc = new MergeOrchestrator({
      store,
      verifierCmd: "true",
      artifactDirBase: join(base, "artifacts"),
      worktreeBase: join(base, "vt"),
      approvalGranted: true,
      remoteUrl: remote,
    });
    const r = await orc.mergeTask("task_push", repo);
    expect(r.status).toBe("merged");
    const remoteSha = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
      encoding: "utf8",
    }).trim();
    expect(remoteSha).toBe(git(repo, ["rev-parse", "main"]).trim());
    expect(store.getTask("task_push")!.status).toBe("done");
  });

  it("push ditolak terus → retry ≤ batas → task failed + instruksi manual (PUSH_REJECTED)", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    makeWorkerBranch(repo, "task_pfail", "notes.txt", "x\n");
    const store = makeStore(join(base, "tasks.db"));
    store.createTask({ task_id: "task_pfail", status: "running", lane: "debug" });
    const orc = new MergeOrchestrator({
      store,
      verifierCmd: "true",
      artifactDirBase: join(base, "artifacts"),
      worktreeBase: join(base, "vt"),
      approvalGranted: true,
      remoteUrl: join(base, "remote-tidak-ada.git"), // path remote tidak valid → push selalu gagal
      pushRetries: 2,
      pushBackoffMs: [10, 10],
    });
    const r = await orc.mergeTask("task_pfail", repo);
    expect(r.status).toBe("push_rejected");
    expect(r.reason).toContain("Manual:");
    const t = store.getTask("task_pfail")!;
    expect(t.status).toBe("failed");
    expect(t.error).toContain("PUSH_REJECTED");
    // merge lokal tetap ada (main-local) — hanya push remote yang ditolak
    expect(git(repo, ["rev-parse", "main-local"]).trim()).toBe(git(repo, ["rev-parse", "main"]).trim());
  });

  it("task dengan status bukan running/blocked → bad_state (tidak menyentuh repo)", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const store = makeStore(join(base, "tasks.db"));
    store.createTask({ task_id: "task_q", status: "queued", lane: "debug" });
    const orc = new MergeOrchestrator({ store, verifierCmd: "true", artifactDirBase: join(base, "a") });
    const r = await orc.mergeTask("task_q", repo);
    expect(r.status).toBe("bad_state");
    expect(git(repo, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
  });
});