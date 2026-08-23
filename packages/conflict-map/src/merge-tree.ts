/**
 * merge-tree.ts — deteksi overlap file antar branch SEBELUM merge (TASK-2.1 pre-merge check).
 *
 * Deteksi dini > resolusi: biaya deteksi ~ms, biaya konflik merge ~menit. Prioritas
 * FALSE POSITIVE (aman): file yang disentuh KEDUA sisi merge pair dianggap overlap,
 * meskipun regionnya berbeda (auto-merge mungkin bersih). Overlap → merge sequential
 * diwajibkan + sisanya di-merge file-per-file oleh orchestrator.
 *
 * Plumbing git yang dipakai (stabil, tanpa library tambahan):
 * - `git merge-tree --write-tree --name-only <A> <B>` — tanpa checkout, murah; pada
 *   conflict menulis nama file conflict ke stdout + exit 1 (git ≥ 2.38).
 * - `git diff --name-only <base> <branch>` — himpunan file berubah per sisi; irisan
 *   kedua himpunan = file disentuh dua-duanya (deteksi lebih lunak dari merge-tree).
 * Union keduanya dipakai agar false negative ditekan (deteksi over resolusi).
 */
import { execFileSync } from "node:child_process";

export const CONFLICT_MAP_VERSION = "0.1.0";

export interface GitRunResult {
  stdout: string;
  exitCode: number;
}

/** Jalankan git; tidak throw saat exit non-0 (merge-tree wajar exit 1 pada conflict). */
export function runGitCapture(repo: string, args: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    return { stdout: String(e.stdout ?? ""), exitCode: e.status ?? 1 };
  }
}

/** `git merge-base A B` → sha atau null (histori tak berhubungan). */
export function mergeBaseOf(repo: string, branchA: string, branchB: string): string | null {
  const r = runGitCapture(repo, ["merge-base", branchA, branchB]);
  const sha = r.stdout.trim().split("\n")[0] ?? "";
  return r.exitCode === 0 && /^[0-9a-f]{7,}$/.test(sha) ? sha : null;
}

/** File yang berubah antara base dan branch (`git diff --name-only base branch`). */
export function changedFilesBetween(repo: string, base: string, branch: string): string[] {
  const r = runGitCapture(repo, ["diff", "--name-only", base, branch]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export interface MergeTreeNameOnlyResult {
  /** Nama file conflict menurut `git merge-tree --write-tree --name-only` (baris setelah oid tree). */
  files: string[];
  exitCode: number;
}

/**
 * `git merge-tree --write-tree --name-only <A> <B>` — tidak checkout, mendeteksi
 * file yang conflict jika kedua branch di-merge. Baris pertama stdout = oid tree,
 * sisanya nama file conflict. exit 1 = ada conflict.
 */
export function mergeTreeNameOnly(repo: string, branchA: string, branchB: string): MergeTreeNameOnlyResult {
  const r = runGitCapture(repo, ["merge-tree", "--write-tree", "--name-only", branchA, branchB]);
  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // baris pertama oid tree; sisanya nama file. Ada kemungkinan stdout CMD_EXIT
  // menyisipkan baris lain di distribusi lama — filter baris bergaris miring (path).
  const files = lines.slice(1).filter((l) => l.includes("/") || l.includes("."));
  return { files, exitCode: r.exitCode };
}

/**
 * Overlap file merge pair `A vs B` (union dua deteksi, false-positive-leaning):
 * 1. irisan `changedFiles(base→A)` ∩ `changedFiles(base→B)` — file disentuh dua-duanya;
 * 2. file conflict dari `git merge-tree --name-only`.
 * Return [] = aman di-merge paralel.
 */
export function mergeTreeOverlap(repo: string, branchA: string, branchB: string): string[] {
  const base = mergeBaseOf(repo, branchA, branchB);
  const intersected: string[] = [];
  if (base) {
    const a = new Set(changedFilesBetween(repo, base, branchA));
    for (const f of changedFilesBetween(repo, base, branchB)) {
      if (a.has(f)) intersected.push(f);
    }
  }
  const viaMergeTree = mergeTreeNameOnly(repo, branchA, branchB).files;
  return [...new Set([...intersected, ...viaMergeTree])];
}

/** Sha HEAD sebuah ref di repo (mis. "main", "worker/task_x"). */
export function revParse(repo: string, ref: string): string | null {
  const r = runGitCapture(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}