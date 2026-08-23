/**
 * omp-bridge unit tests — TASK-1.3.
 * - timeout → { code: "TIMEOUT" } dalam < 305s (mock spawn, kill terbukti cepat)
 * - repo di luar allowlist → REPO_NOT_ALLOWED tanpa spawn (mock call counter = 0)
 * - worktree isolation: perubahan HANYA di worktree, repo utama bersih
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMockFix, FIXED_ADD, BUGGY_ADD } from "../src/mock-worker.js";
import {
  isPathAllowed,
  removeWorktree,
  runTask,
} from "../src/index.js";
import type { TaskSpec } from "handoff-contract";

const SPEC: TaskSpec = {
  task_id: "task_unit_01",
  lane: "debug",
  objective: "fix bug: fungsi add salah return",
  files_owned: ["lib/math.py"],
  requirements: ["add(2,3) harus 5"],
  acceptance_criteria: ["pytest hijau"],
  boundaries: ["hanya ubah lib/math.py"],
  verification_steps: ["true"],
};

const VALID_SPEC = { ...SPEC };

function runGit(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

/** Buat mini git repo dengan buggy add (seperti tests/fixtures/repo-a). */
function makeRepo(dir: string): string {
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "lib", "math.py"),
    "def add(a: int, b: int) -> int:\n    return a - b  # BUG\n",
  );
  writeFileSync(join(dir, "tests", "test_math.py"), "from lib.math import add\n\ndef test_add():\n    assert add(2, 3) == 5\n");
  runGit(dir, ["init", "-q", "-b", "main"]);
  runGit(dir, ["-c", "user.name=unit", "-c", "user.email=u@local", "add", "-A"]);
  runGit(dir, ["-c", "user.name=unit", "-c", "user.email=u@local", "commit", "-qm", "init"]);
  return dir;
}

function makeMarkerScript(dir: string, kind: "sleep" | "marker"): string {
  const script = join(dir, `mock-${kind}.sh`);
  const body =
    kind === "sleep"
      ? "#!/usr/bin/env bash\nsleep 60\n"
      : '#!/usr/bin/env bash\necho "started $(date +%s)" >> "$OMP_BRIDGE_MOCK_MARKER"\nsleep 5\n';
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return script;
}

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-bridge-test-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("applyMockFix (mock worker logic)", () => {
  it("mengganti baris buggy `return a - b` dengan `return a + b`", () => {
    const repo = makeRepo(join(tmp(), "repo"));
    const { changedFiles } = applyMockFix(repo, SPEC);
    expect(changedFiles).toContain("lib/math.py");
    const fixed = readFileSync(join(repo, "lib", "math.py"), "utf8");
    expect(fixed).toContain(FIXED_ADD);
    expect(fixed).not.toContain(BUGGY_ADD);
  });
});

describe("allowlist", () => {
  it("isPathAllowed true untuk path di allowlist, false untuk di luar", () => {
    const repo = makeRepo(join(tmp(), "repo"));
    expect(isPathAllowed(repo, [repo])).toBe(true);
    expect(isPathAllowed(repo, [join(tmp(), "lain")])).toBe(false);
    expect(isPathAllowed(repo, [])).toBe(false);
  });
});

describe("runTask — success path (mock worker, worktree isolation)", () => {
  it("exitCode 0 + diffSummary berisi lib/math.py; repo utama TIDAK berubah", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const result = await runTask(VALID_SPEC, repo, {
      mock: true,
      allowlist: [repo],
      timeoutMs: 30_000,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.exitCode).toBe(0);
    expect(result.diffSummary).toContain("lib/math.py");
    expect(result.diffFull).toContain(FIXED_ADD);
    // worktree dihapus otomatis (keepWorktree=false)
    expect(existsSync(result.worktree)).toBe(false);
    // repo utama tetap buggy → worker tidak menyentuh repo langsung (worktree isolation)
    expect(readFileSync(join(repo, "lib", "math.py"), "utf8")).toContain(BUGGY_ADD);
    // tidak ada worktree sisa
    const list = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
    expect(list.trim().split("\n")).toHaveLength(1);
  });

  it("keepWorktree=true: perubahan ada di worktree, bisa di-commit/merge oleh orchestrator", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const result = await runTask(VALID_SPEC, repo, {
      mock: true,
      allowlist: [repo],
      timeoutMs: 30_000,
      keepWorktree: true,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(existsSync(result.worktree)).toBe(true);
    expect(readFileSync(join(result.worktree, "lib", "math.py"), "utf8")).toContain(FIXED_ADD);
    expect(readFileSync(join(repo, "lib", "math.py"), "utf8")).toContain(BUGGY_ADD);
    removeWorktree(repo, result.worktree);
    expect(existsSync(result.worktree)).toBe(false);
  });
});

describe("runTask — TIMEOUT", () => {
  it("mock spawn yang tidur → { code: TIMEOUT } cepat (kill, bukan tunggu)", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const sleepScript = makeMarkerScript(base, "sleep");
    const started = Date.now();
    const result = await runTask(VALID_SPEC, repo, {
      mockCommand: [sleepScript],
      allowlist: [repo],
      timeoutMs: 400,
    });
    const elapsedMs = Date.now() - started;
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("TIMEOUT");
    expect(result.message).toContain("timeout");
    // dibunuh segera — jauh di bawah batas acceptance < 305s
    expect(elapsedMs).toBeLessThan(5_000);
    // cleanup: tidak ada worktree sisa
    const list = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
    expect(list.trim().split("\n")).toHaveLength(1);
  });
});

describe("runTask — REPO_NOT_ALLOWED tanpa spawn", () => {
  it("repo di luar allowlist → REPO_NOT_ALLOWED, mock call counter = 0, tanpa worktree", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const otherRepo = makeRepo(join(base, "repo-lain"));
    const marker = join(base, "spawn-counter.txt");
    const markerScript = makeMarkerScript(base, "marker");

    const result = await runTask(VALID_SPEC, otherRepo, {
      mockCommand: [markerScript],
      allowlist: [repo], // otherRepo TIDAK ada di allowlist
      env: { OMP_BRIDGE_MOCK_MARKER: marker },
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("REPO_NOT_ALLOWED");
    expect(result.message).toContain("spawn");
    // mock call counter = 0 → marker tidak pernah ditulis
    expect(existsSync(marker)).toBe(false);
    // tidak ada worktree dibuat sama sekali
    const list = execFileSync("git", ["-C", otherRepo, "worktree", "list"], { encoding: "utf8" });
    expect(list.trim().split("\n")).toHaveLength(1);
  });
});

describe("runTask — INVALID_SPEC & SPAWN_ERROR", () => {
  it("task spec tidak valid → INVALID_SPEC tanpa spawn", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const marker = join(base, "spawn-counter.txt");
    const markerScript = makeMarkerScript(base, "marker");
    const result = await runTask({ task_id: "x" }, repo, {
      mockCommand: [markerScript],
      allowlist: [repo],
      env: { OMP_BRIDGE_MOCK_MARKER: marker },
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("INVALID_SPEC");
    expect(existsSync(marker)).toBe(false);
  });

  it("command worker tidak ada → SPAWN_ERROR yang jelas", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const result = await runTask(VALID_SPEC, repo, {
      mockCommand: [join(base, "nonexistent-cmd-xyz")],
      allowlist: [repo],
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("SPAWN_ERROR");
  });
});

describe("runTask — allowlist via env", () => {
  it("OMP_BRIDGE_ALLOWLIST (env) dipakai sebagai default allowlist", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const prev = process.env.OMP_BRIDGE_ALLOWLIST;
    process.env.OMP_BRIDGE_ALLOWLIST = repo;
    try {
      const result = await runTask(VALID_SPEC, repo, { mock: true, timeoutMs: 30_000 });
      expect(result.status).toBe("ok");
    } finally {
      if (prev === undefined) delete process.env.OMP_BRIDGE_ALLOWLIST;
      else process.env.OMP_BRIDGE_ALLOWLIST = prev;
    }
  });
});

describe("worker exitCode non-0 (test merah) TIDAK jadi error bridge", () => {
  it("verification gagal → status ok dengan exitCode=1 (keputusan di orchestrator)", async () => {
    const base = tmp();
    const repo = makeRepo(join(base, "repo"));
    const failScript = join(base, "fail.sh");
    writeFileSync(failScript, "#!/usr/bin/env bash\necho 'pytest: 1 failed'\nexit 1\n");
    chmodSync(failScript, 0o755);
    const result = await runTask(VALID_SPEC, repo, {
      mockCommand: [failScript],
      allowlist: [repo],
      timeoutMs: 10_000,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.exitCode).toBe(1);
    expect(result.stdoutTail).toContain("1 failed");
  });
});