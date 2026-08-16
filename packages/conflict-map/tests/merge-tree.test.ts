/**
 * Unit test merge-tree (TASK-2.1 pre-merge check).
 * Bukti: fixture 2 branch yang mengedit file SAMA → `git merge-tree --name-only`
 * memuat file itu; branch disjoint → tanpa overlap; irisan diff menangkap kasus
 * soft (region berbeda) yang tidak dianggap conflict merge-tree.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedFilesBetween,
  mergeBaseOf,
  mergeTreeNameOnly,
  mergeTreeOverlap,
  revParse,
} from "../src/merge-tree.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-mt-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** Mini repo: file lib/math.py (SAMA di semua branch test). */
function makeRepo(dir: string): string {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "math.py"), "def add(a: int, b: int) -> int:\n    return a - b\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["-c", "user.name=unit", "-c", "user.email=u@local", "add", "-A"]);
  git(dir, ["-c", "user.name=unit", "-c", "user.email=u@local", "commit", "-qm", "base"]);
  return dir;
}

function commitFile(repo: string, branch: string, file: string, content: string, msg: string): void {
  git(repo, ["switch", "-q", "-C", branch]); // dibuat dulu by caller
  writeFileSync(join(repo, file), content);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=unit", "-c", "user.email=u@local", "commit", "-qm", msg]);
}

describe("merge-tree — deteksi overlap antar branch (TASK-2.1/2.3)", () => {
  it("2 branch mengedit file SAMA (baris sama) → git merge-tree --name-only memuat file itu", () => {
    const repo = makeRepo(join(tmp(), "repo"));
    git(repo, ["branch", "branchA", "main"]);
    git(repo, ["branch", "branchB", "main"]);
    commitFile(repo, "branchA", "lib/math.py", "def add(a: int, b: int) -> int:\n    return a + b\n", "A edit math");
    git(repo, ["switch", "-q", "main"]);
    commitFile(repo, "branchB", "lib/math.py", "def add(a: int, b: int) -> int:\n    return a * b\n", "B edit math");

    const byGit = mergeTreeNameOnly(repo, "branchA", "branchB");
    expect(byGit.exitCode).toBe(1); // git nganggap conflict
    expect(byGit.files).toContain("lib/math.py"); // ← bukti deteksi

    const overlap = mergeTreeOverlap(repo, "branchA", "branchB");
    expect(overlap).toContain("lib/math.py");
  });

  it("branch disjoint (file berbeda) → TANPA overlap, tidak ada 'merge paralel' yang terdeteksi", () => {
    const repo = makeRepo(join(tmp(), "repo"));
    git(repo, ["branch", "branchA", "main"]);
    git(repo, ["branch", "branchB", "main"]);
    commitFile(repo, "branchA", "lib/feature.py", "def double(x):\n    return x * 2\n", "A adds feature");
    git(repo, ["switch", "-q", "main"]);
    commitFile(repo, "branchB", "lib/greet.py", "def greet():\n    return 'Hello'\n", "B adds greet");

    expect(mergeTreeNameOnly(repo, "branchA", "branchB").files).toEqual([]);
    expect(mergeTreeOverlap(repo, "branchA", "branchB")).toEqual([]);
  });

  it("file sama tapi region beda (auto-merge bersih) → irisan diff tetap deteksi (false-positive-leaning)", () => {
    const repo = makeRepo(join(tmp(), "repo"));
    git(repo, ["branch", "branchA", "main"]);
    git(repo, ["branch", "branchB", "main"]);
    commitFile(repo, "branchA", "lib/math.py", "def add(a: int, b: int) -> int:\n    return a + b\n\ndef sub(a: int, b: int) -> int:\n    return a - b\n", "A rewrites add");
    git(repo, ["switch", "-q", "main"]);
    commitFile(repo, "branchB", "lib/math.py", "def add(a: int, b: int) -> int:\n    return a + 0\n\ndef mul(a: int, b: int) -> int:\n    return a * b\n", "B rewrites add+adds mul");

    // merge-tree conflict? mungkin bersih (beda region) → gunakan irisan diff
    const base = mergeBaseOf(repo, "branchA", "branchB");
    expect(base).not.toBeNull();
    const aFiles = changedFilesBetween(repo, base!, "branchA");
    const bFiles = changedFilesBetween(repo, base!, "branchB");
    expect(aFiles).toContain("lib/math.py");
    expect(bFiles).toContain("lib/math.py");
    // deteksi = UNION → math.py masuk overlap walaupun merge-tree tidak conflict
    expect(mergeTreeOverlap(repo, "branchA", "branchB")).toContain("lib/math.py");
  });

  it("revParse: sha HEAD branch valid; ref tak dikenal → null", () => {
    const repo = makeRepo(join(tmp(), "repo"));
    const sha = revParse(repo, "main");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(revParse(repo, "tidak-ada-ref")).toBeNull();
  });
});