/**
 * omp-bridge — bridge Hermes (orchestrator) ↔ worker (oh-my-pi / mock).
 *
 * TASK-1.3: runTask(taskSpec, repoPath, opts) → { exitCode, stdoutTail, diffSummary }
 * - Worktree isolation: worker tidak pernah menyentuh repo langsung (git worktree --detach).
 * - Timeout (default 300s) → kill(SIGKILL) → { code: "TIMEOUT" } — jangan hanging.
 * - Repo allowlist: repo di luar allowlist → { code: "REPO_NOT_ALLOWED" } TANPA spawn.
 * - MOCK mode (OMP_BRIDGE_MOCK=1): spawn mock worker deterministik (fixture-fixing)
 *   alih-alih `omp --mode rpc` — lihat docs/adr/0002-omp-transport.md & docs/BLOCKERS.md (OMP-001).
 *
 * Transport decision (ADR-002): RPC stdio (`omp --mode rpc`) dipilih sebagai transport
 * nyata; mock worker adalah fallback FASE-1 karena bin omp rusak (OMP-001).
 *
 * FASE-2 (TASK-2.2): WorkerManager — pool ≤ 3 (hard cap), FIFO queue,
 * timeout/kill/retry idempoten, heartbeat; lihat src/manager.ts.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskSpecSchema, type TaskSpec } from "handoff-contract";

export * from "./manager.js";
export * from "./safety.js";
export * from "./errors.js";
export const BRIDGE_VERSION = "0.1.0";

/** Default timeout worker: 300 detik (TASK-1.3). */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Nama file spec yang ditulis ke worktree base untuk mock worker (di luar worktree, tidak masuk diff). */
const SPEC_FILE_PREFIX = "omp-spec-";

/**
 * Lokasi package root (punya package.json). Dipakai untuk menemukan dist/mock-worker-cli.js.
 * Catatan: di vitest, import.meta.url menunjuk ke src/ (transpilasi) — bukan dist/.
 * Jadi jangan pernah derive path dist dari import.meta.url langsung.
 */
export function findPackageRoot(startFile: string): string {
  let dir = dirname(startFile);
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(startFile);
}

export type BridgeErrorCode =
  | "TIMEOUT"
  | "REPO_NOT_ALLOWED"
  | "INVALID_SPEC"
  | "SPAWN_ERROR"
  | "WORKTREE_ERROR";

export interface RunTaskResultOk {
  status: "ok";
  /** Exit code proses worker (0 = sukses + verifikasi hijau). */
  exitCode: number;
  /** Ekor stdout worker (maks ~64KB, baris terakhir). */
  stdoutTail: string;
  /** `git diff HEAD --stat` di worktree — ringkasan perubahan worker. */
  diffSummary: string;
  /** Diff penuh (patch) — untuk artifact. */
  diffFull: string;
  /** Path worktree (masih ada hanya jika opts.keepWorktree=true). */
  worktree: string;
  /** PID proses worker (dipakai worker manager: zombie/pid record). */
  pid?: number | null;
}

export interface RunTaskResultErr {
  status: "error";
  code: BridgeErrorCode;
  message: string;
  /** PID proses worker bila sempat spawn (TIMEOUT/kill-failed). */
  pid?: number | null;
}

export type RunTaskResult = RunTaskResultOk | RunTaskResultErr;

export interface RunTaskOptions {
  /** Batas waktu worker dalam ms. Default 300_000. */
  timeoutMs?: number;
  /** Allowlist repo (path absolut). Kosong = deny-all. Default: env OMP_BRIDGE_ALLOWLIST (":"-separated). */
  allowlist?: string[];
  /** Base dir worktree. Default os.tmpdir()/sk-omp. */
  worktreeBase?: string;
  /** Jangan hapus worktree setelah selesai (caller wajib removeWorktree). Default false. */
  keepWorktree?: boolean;
  /** Paksa mock mode. Default: env OMP_BRIDGE_MOCK=1. */
  mock?: boolean;
  /** Override command worker (dipakai unit test). */
  mockCommand?: string[];
  /** Env tambahan untuk proses worker. */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/** Parse env OMP_BRIDGE_ALLOWLIST (":") → array path. */
export function parseAllowlistEnv(): string[] {
  const raw = process.env.OMP_BRIDGE_ALLOWLIST ?? "";
  return raw
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function normalizeReal(p: string): string {
  try {
    return realpathSync(p).replace(/\/+$/, "");
  } catch {
    return resolve(p).replace(/\/+$/, "");
  }
}

/** Apakah repoPath ada di allowlist (pembandingan real path). */
export function isPathAllowed(repoPath: string, allowlist: string[]): boolean {
  const real = normalizeReal(repoPath);
  return allowlist.some((entry) => normalizeReal(entry) === real);
}

// ---------------------------------------------------------------------------
// Worktree
// ---------------------------------------------------------------------------

function createWorktree(repoPath: string, taskId: string, base: string): string {
  mkdirSync(base, { recursive: true });
  const worktree = join(
    base,
    `wt-${taskId.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  // --detach: branch main tetap di worktree utama; worker tidak pernah checkout branch.
  execFileSync("git", ["-C", repoPath, "worktree", "add", "--detach", worktree, "HEAD"], {
    stdio: "pipe",
  });
  return worktree;
}

/** Hapus worktree (git worktree remove --force + fallback rm -rf). Idempotent. */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  try {
    execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath], {
      stdio: "pipe",
    });
  } catch {
    // fallback: hapus direktori; metadata worktree dibersihkan via `git worktree prune` berikutnya
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Worker spawn
// ---------------------------------------------------------------------------

async function runWorker(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  stdinPayload: string | null,
): Promise<{ exitCode: number | null; signal: string | null; stdoutTail: string; timedOut: boolean; pid: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const CAP = 64 * 1024;
    let out = "";
    const collect = (chunk: Buffer): void => {
      if (out.length >= CAP) return;
      out += chunk.toString().slice(0, CAP - out.length);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // process sudah mati
      }
    }, Math.max(1, timeoutMs));

    child.on("error", (_err: Error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, signal: null, stdoutTail: out, timedOut, pid: child.pid ?? null });
    });

    if (stdinPayload !== null) {
      try {
        child.stdin?.write(stdinPayload);
      } catch {
        // stdin sudah ditutup — abaikan
      }
    }
    try {
      child.stdin?.end();
    } catch {
      // abaikan
    }

    // 'exit' (bukan 'close'): close menunggu stdio stream tertutup — anak (mis. `sleep`)
    // yang mewarisi fd stdout bisa menunda close hingga berjam-jam setelah proses mati.
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const tail = out.split("\n").slice(-60).join("\n").trim();
      resolvePromise({ exitCode: code, signal, stdoutTail: tail, timedOut, pid: child.pid ?? null });
    });
  });
}

function gitDiff(worktree: string): { diffFull: string; diffSummary: string } {
  try {
    const diffFull = execFileSync("git", ["-C", worktree, "diff", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const stat = execFileSync("git", ["-C", worktree, "diff", "HEAD", "--stat"], {
      encoding: "utf8",
    });
    return { diffFull, diffSummary: stat.trim() || "(tidak ada perubahan di worktree)" };
  } catch (err) {
    return {
      diffFull: "",
      diffSummary: `(gagal membaca diff: ${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

// ---------------------------------------------------------------------------
// runTask — API utama (dipakai tool Hermes omp_spawn_worker, lihat docs/api.md §3.1)
// ---------------------------------------------------------------------------

/**
 * Delegasikan 1 task coding ke worker di worktree terisolasi.
 * - Spec divalidasi zod dulu (INVALID_SPEC — tanpa spawn).
 * - Repo di luar allowlist → REPO_NOT_ALLOWED (tanpa spawn, tanpa worktree).
 * - Timeout → kill(SIGKILL) → TIMEOUT. Worker timeout ≠ gagal: cek side-effect
 *   (file/diff) sebelum re-dispatch.
 */
export async function runTask(
  taskSpecInput: unknown,
  repoPath: string,
  opts: RunTaskOptions = {},
): Promise<RunTaskResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const parsed = TaskSpecSchema.safeParse(taskSpecInput);
  if (!parsed.success) {
    return {
      status: "error",
      code: "INVALID_SPEC",
      message: `task spec gagal validasi zod: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const spec: TaskSpec = parsed.data;

  const allowlist = opts.allowlist ?? parseAllowlistEnv();
  if (!isPathAllowed(repoPath, allowlist)) {
    return {
      status: "error",
      code: "REPO_NOT_ALLOWED",
      message: `repo ${repoPath} tidak ada di allowlist — ditolak TANPA spawn`,
    };
  }

  const worktreeBase = resolve(opts.worktreeBase ?? join(tmpdir(), "sk-omp"));
  let worktree: string;
  try {
    worktree = createWorktree(repoPath, spec.task_id, worktreeBase);
  } catch (err) {
    return {
      status: "error",
      code: "WORKTREE_ERROR",
      message: `gagal membuat git worktree: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const mock = opts.mock ?? (process.env.OMP_BRIDGE_MOCK !== "0");
  const specFile = join(worktreeBase, `${SPEC_FILE_PREFIX}${spec.task_id}-${Date.now()}.json`);
  try {
    writeFileSync(specFile, JSON.stringify(spec));
    const workerCmd =
      opts.mockCommand ??
      (mock
        ? [
            process.execPath,
            join(findPackageRoot(fileURLToPath(import.meta.url)), "dist", "mock-worker-cli.js"),
            worktree,
            specFile,
          ]
        : ["omp", "--mode", "rpc"]);

    const payload = mock ? null : `${JSON.stringify(spec)}\n`;
    const { exitCode, stdoutTail, timedOut, pid } = await runWorker(
      workerCmd,
      worktree,
      { OMP_BRIDGE_WORKTREE: worktree, OMP_BRIDGE_SPEC_FILE: specFile, ...(opts.env ?? {}) },
      timeoutMs,
      payload,
    );

    if (timedOut) {
      removeWorktree(repoPath, worktree);
      rmSync(specFile, { force: true });
      return {
        status: "error",
        code: "TIMEOUT",
        pid,
        message: `worker melebihi timeout ${timeoutMs}ms — proses di-kill (SIGKILL). Worker timeout ≠ gagal: cek side-effect (file/diff) sebelum re-dispatch.`,
      };
    }

    if (exitCode === null) {
      removeWorktree(repoPath, worktree);
      rmSync(specFile, { force: true });
      return {
        status: "error",
        code: "SPAWN_ERROR",
        pid,
        message: `gagal spawn worker "${workerCmd[0]}": ${stdoutTail || "unknown error"} (bin omp rusak? lihat docs/BLOCKERS.md OMP-001)`,
      };
    }

    const { diffFull, diffSummary } = gitDiff(worktree);
    if (!opts.keepWorktree) {
      removeWorktree(repoPath, worktree);
    }
    rmSync(specFile, { force: true });
    return { status: "ok", exitCode, stdoutTail, diffSummary, diffFull, worktree, pid };
  } catch (err) {
    // error tak terduga (mis. writeFileSync gagal) — bersihkan side-effect
    removeWorktree(repoPath, worktree);
    rmSync(specFile, { force: true });
    return {
      status: "error",
      code: "SPAWN_ERROR",
      message: `error tak terduga di bridge: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}