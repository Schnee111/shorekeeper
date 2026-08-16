/**
 * mock-worker — worker omp DETERMINISTIK untuk FASE-1 (fallback OMP-001).
 *
 * Menggantikan `omp --mode rpc` yang rusak (bin meng-import ../src/*.ts yang tidak
 * ikut di-pack — lihat docs/BLOCKERS.md OMP-001 & docs/adr/0002-omp-transport.md).
 *
 * Perilaku (deterministik, tanpa network):
 * 1. Terapkan fix fixture: di lib/math.py ganti `return a - b` (bug) → `return a + b`.
 * 2. Jalankan verification_steps dari task spec (shell, cwd = worktree).
 *    - Semua hijau → exit 0; ada merah → exit 1 (worker selesai tapi test merah).
 *
 * Dukungan unit test (via env):
 * - OMP_BRIDGE_MOCK_MARKER=<path> — tulis marker di awal (bukti spawn / counter).
 * - OMP_BRIDGE_MOCK_SLEEP_MS=<n>  — tidur n ms dulu (uji timeout).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskSpecSchema, type TaskSpec } from "handoff-contract";

export const BUGGY_ADD = "return a - b";
export const FIXED_ADD = "return a + b";

export interface MockFixResult {
  changedFiles: string[];
}

/** Fix deterministik fixture repo-a: koreksi fungsi add di lib/math.py. */
export function applyMockFix(worktree: string, _spec: Pick<TaskSpec, "task_id" | "objective">): MockFixResult {
  const changedFiles: string[] = [];
  const mathPath = join(worktree, "lib", "math.py");
  if (existsSync(mathPath)) {
    const src = readFileSync(mathPath, "utf8");
    if (src.includes(BUGGY_ADD)) {
      writeFileSync(mathPath, src.split(BUGGY_ADD).join(FIXED_ADD));
      changedFiles.push("lib/math.py");
    }
  }
  return { changedFiles };
}

/** Jalankan verification_steps spec di cwd worktree. Return true bila semua hijau. */
export function runVerificationSteps(worktree: string, spec: TaskSpec): { ok: boolean; output: string } {
  let output = "";
  for (const step of spec.verification_steps) {
    const r = spawnSync(step, {
      cwd: worktree,
      shell: true,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
      },
    });
    if (r.stdout) output += r.stdout;
    if (r.stderr) output += r.stderr;
    if (r.status !== 0) {
      return { ok: false, output };
    }
  }
  return { ok: true, output };
}

/** Entry mock worker (dipanggil dari CLI): [worktreePath, specPath] → exit code. */
export async function runMockWorker(argv: string[]): Promise<number> {
  const [worktree, specPath] = argv;
  if (!worktree || !specPath) {
    console.error("[mock-worker] usage: mock-worker <worktreePath> <specPath>");
    return 2;
  }
  const parsed = TaskSpecSchema.safeParse(JSON.parse(readFileSync(specPath, "utf8")));
  if (!parsed.success) {
    console.error("[mock-worker] task spec invalid:", parsed.error.message);
    return 2;
  }
  const spec = parsed.data;

  if (process.env.OMP_BRIDGE_MOCK_MARKER) {
    writeFileSync(process.env.OMP_BRIDGE_MOCK_MARKER, JSON.stringify({ startedAt: Date.now() }));
  }
  const sleepMs = Number(process.env.OMP_BRIDGE_MOCK_SLEEP_MS ?? 0);
  if (sleepMs > 0) {
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  const { changedFiles } = applyMockFix(worktree, spec);
  console.log(
    `[mock-worker] changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "(none)"}`,
  );

  const { ok, output } = runVerificationSteps(worktree, spec);
  if (output) process.stdout.write(output);
  if (!ok) {
    console.error("[mock-worker] VERIFY_FAILED: verification_steps tidak hijau");
    return 1;
  }
  console.log("[mock-worker] done OK");
  return 0;
}