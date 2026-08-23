/**
 * harness.mjs — pelaksana kasus golden (TASK-3.3 requirement 2).
 *
 * Setiap kasus YAML punya `harness.action` deterministik (tanpa network):
 * shell E2E (fase 1/2, smoke) atau in-process (store/manager/orchestrator).
 * Result: { ok, reasons[], meta } — meta dipakai judge (tool_use/safety/voice).
 * Kasus yang CRASH di runner (bukan gagal task) dihitung `runner_error`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskStore } from "../../packages/task-store/dist/index.js";
import { WorkerManager, scanSpecForbidden, specTexts } from "../../packages/omp-bridge/dist/index.js";
import { MergeOrchestrator } from "../../packages/merge-orchestrator/dist/index.js";

export const ROOT = resolve(import.meta.dirname, "../..");
const VERIFY_CMD = `uv run --project ${ROOT}/apps/agent python -m pytest -q tests -p no:cacheprovider`;

function runScript(cmd, env = {}, opts = {}) {
  try {
    const out = execFileSync("bash", ["-c", cmd], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? 420_000,
      env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "none", ...env },
    });
    return { exit: 0, out };
  } catch (err) {
    return { exit: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function tmpDb(tag) {
  const d = mkdtempSync(join(tmpdir(), `sk-gs-${tag}-`));
  return { dir: d, db: join(d, "tasks.db") };
}

const okRunner = {
  async run() {
    return { status: "ok", exitCode: 0, stdoutTail: "ok", diffSummary: "(none)", diffFull: "", worktree: "" };
  },
};

/** Router deterministik untuk kasus routing/handoff (bukan LLM — eval orkestrasi). */
function routeIntent(intent) {
  const s = intent.toLowerCase();
  // status: hanya kalimat TANYA progress — kata "status" sebagai entitas
  // ("endpoint /status") BUKAN query status.
  if (/(progress|gimana|sampai mana|statusnya|status (task|tadi))/.test(s)) return { kind: "status", lane: null, confidence: 0.9 };
  if (/(stop|batalkan|batal)/.test(s)) return { kind: "cancel", lane: null, confidence: 0.9 };
  if (/(semua|batch|label)/.test(s)) return { kind: "batch", lane: "debug", confidence: 0.7 };
  if (/(script|buatin|rename|file)/.test(s) && !/issue|bug|repo/.test(s)) return { kind: "clarify", lane: null, confidence: 0.4 };
  if (/(riset|research|cari tahu|bandingkan)/.test(s)) return { kind: "task", lane: "research", confidence: 0.85 };
  if (/(ui|frontend|halaman|css|svelte)/.test(s)) return { kind: "task", lane: "frontend", confidence: 0.85 };
  if (/(test|qa|regresi)/.test(s)) return { kind: "task", lane: "qa", confidence: 0.85 };
  if (/(issue|bug|error|fix|repo|kerjakan)/.test(s)) return { kind: "task", lane: "debug", confidence: 0.85 };
  return { kind: "clarify", lane: null, confidence: 0.3 };
}

// ---------------------------------------------------------------------------
// Aksi-aksi harness
// ---------------------------------------------------------------------------

const actions = {
  /** Routing handoff → task di lane yang benar (kontrak zod + store). */
  async route(c) {
    const reasons = [];
    const r = routeIntent(c.input.intent);
    const exp = c.expected_outcome;
    reasons.push(`router: kind=${r.kind} lane=${r.lane ?? "-"} conf=${r.confidence}`);
    if (r.kind !== exp.route_kind) return { ok: false, reasons, meta: { route: r } };
    if (r.kind === "task") {
      const t = tmpDb(c.id);
      const store = new TaskStore({ dbPath: t.db });
      const rec = store.createTask({ task_id: c.id, lane: r.lane, user_intent: c.input.intent, session_room: "golden" });
      reasons.push(`store: task ${rec.task_id} lane=${rec.lane} status=${rec.status}`);
      store.close();
      rmSync(t.dir, { recursive: true, force: true });
      if (rec.lane !== exp.lane) return { ok: false, reasons, meta: { route: r } };
    }
    return { ok: true, reasons, meta: { route: r, lane: r.lane } };
  },

  /** Query status: checkTaskStatus mengembalikan narasi benar dari store. */
  async status_query(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    store.createTask({ task_id: "gs_active_1", lane: "debug" });
    store.transition("gs_active_1", "running");
    store.createTask({ task_id: "gs_done_1", lane: "qa" });
    store.transition("gs_done_1", "running");
    store.transition("gs_done_1", "done", { summary: "selesai diverifikasi" });
    const res = store.checkTaskStatus("active");
    const reasons = [`narratable ${res.narratable.length} baris`, `counts running=${res.counts.running}`];
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const exp = c.expected_outcome;
    const ok =
      res.counts.running === exp.count_running &&
      res.narratable.length <= exp.max_lines &&
      res.narratable.some((l) => l.includes("gs_active_1"));
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { narratable: res.narratable } };
  },

  /** Pembatalan: queued → cancelled via state machine + narasi. */
  async cancel(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    store.createTask({ task_id: "gs_cancel_1", lane: "debug" });
    store.transition("gs_cancel_1", "cancelled");
    const rec = store.getTask("gs_cancel_1");
    const status = store.checkTaskStatus(["gs_cancel_1"]);
    const reasons = [`status=${rec.status}`, `narasi="${status.narratable[0]}"`];
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const ok = rec.status === c.expected_outcome.status && /dibatalkan/.test(status.narratable[0] ?? "");
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { narratable: status.narratable, status: rec.status } };
  },

  /** E2E fase 1 penuh (1 task: seed→delegate→merge→verify→done). */
  async run_fase1(c) {
    const env = { E2E_DB: join(tmpdir(), `sk-gs-${c.id}-${Date.now()}.db`) };
    const r = runScript("bash scripts/e2e/run-fase1.sh", env);
    const reasons = [`exit=${r.exit}`];
    const done = /PIPELINE: OK/.test(r.out);
    const ok = c.expected_outcome.exit_code === 0 ? r.exit === 0 && done : r.exit !== 0;
    if (!ok) reasons.push(`MISMATCH (tail: ${r.out.split("\n").slice(-3).join(" | ").slice(0, 200)})`);
    return { ok, reasons, meta: { mechanism: "run-fase1.sh", store: "data/tasks-e2e.db" } };
  },

  /** E2E fase 1 negatif: fixture dipecah → pipeline HARUS gagal (VERIFY_FAILED). */
  async run_fase1_negative(c) {
    const env = { E2E_BREAK_FIXTURE: "1", E2E_DB: join(tmpdir(), `sk-gs-${c.id}-${Date.now()}.db`) };
    const r = runScript("bash scripts/e2e/run-fase1.sh", env, { timeoutMs: 240_000 });
    const reasons = [`exit=${r.exit}`];
    const verifyFailed = /VERIFY_FAILED|worker-verify|verify/.test(r.out);
    const ok = r.exit !== 0 && verifyFailed;
    if (!ok) reasons.push("MISMATCH: negatif harus gagal VERIFY_FAILED");
    return { ok, reasons, meta: { mechanism: "run-fase1.sh negative", verify_failed: verifyFailed } };
  },

  /** E2E fase 2 penuh (skenario A paralel + B konflik + C timeout). */
  async run_fase2(c) {
    const r = runScript("bash scripts/e2e/run-fase2.sh", {}, { timeoutMs: 600_000 });
    const reasons = [`exit=${r.exit}`];
    const ok = c.expected_outcome.exit_code === 0 ? r.exit === 0 : r.exit !== 0;
    if (!ok) reasons.push(`MISMATCH (tail: ${r.out.split("\n").slice(-3).join(" | ").slice(0, 200)})`);
    return { ok, reasons, meta: { mechanism: "run-fase2.sh" } };
  },

  /** Smoke paralel 3 task independen. */
  async smoke_parallel() {
    const r = runScript("bash scripts/e2e/smoke-parallel.sh", {}, { timeoutMs: 300_000 });
    const ok = r.exit === 0;
    return { ok, reasons: [`exit=${r.exit}`], meta: { mechanism: "smoke-parallel.sh" } };
  },

  /** Smoke konflik: 2 task bentrok → sequential, tanpa merge paralel. */
  async smoke_conflict() {
    const r = runScript("bash scripts/e2e/smoke-conflict.sh", {}, { timeoutMs: 300_000 });
    const ok = r.exit === 0;
    return { ok, reasons: [`exit=${r.exit}`], meta: { mechanism: "smoke-conflict.sh" } };
  },

  /** Timeout berulang → retry backoff → failed/<CODE> (N attempts). */
  async timeout_retry(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    const mgr = new WorkerManager({
      store,
      allowlist: [t.dir],
      runner: async () => ({ status: "error", code: "TIMEOUT", message: "mock timeout", pid: null }),
      retryBackoffMs: [10, 10],
      onWorkerReady: (id) => { store.transition(id, "done", { summary: "ok" }); },
    });
    store.createTask({ task_id: "gs_to", lane: "debug" });
    await mgr.spawnTask("gs_to", t.dir, {
      spec: { task_id: "gs_to", lane: "debug", objective: "x", files_owned: [], requirements: [], acceptance_criteria: ["ok"], boundaries: [], verification_steps: [] },
      maxRetries: 2,
    });
    await mgr.drain();
    const rec = store.getTask("gs_to");
    const attempts = mgr.spawnCount;
    mgr.stop();
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const exp = c.expected_outcome;
    const ok = rec.status === exp.status && /TIMEOUT/.test(rec.error ?? "") && attempts === exp.attempts;
    const reasons = [`status=${rec.status} error=${rec.error} attempts=${attempts}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "manager retry backoff", attempts } };
  },

  /** Injection: spec path terlarang → REPO_NOT_ALLOWED, spawn 0. */
  async delegate_safety(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    let runnerCalls = 0;
    const mgr = new WorkerManager({
      store,
      allowlist: [t.dir],
      runner: async () => { runnerCalls += 1; return okRunner.run(); },
    });
    store.createTask({ task_id: "gs_inj", lane: "debug" });
    const spec = {
      task_id: "gs_inj", lane: "debug", objective: c.input.objective,
      files_owned: c.input.files_owned ?? ["lib/x.py"], requirements: c.input.requirements ?? [],
      acceptance_criteria: ["ok"], boundaries: c.input.boundaries ?? [], verification_steps: [],
    };
    const r = await mgr.spawnTask("gs_inj", t.dir, { spec });
    const rec = store.getTask("gs_inj");
    const reasons = [`spawn=${r.status}/${r.reason} spawnCount=${mgr.spawnCount} runnerCalls=${runnerCalls} store=${rec.status}`];
    mgr.stop();
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const exp = c.expected_outcome;
    const ok =
      r.status === "rejected" && r.reason === exp.code && mgr.spawnCount === exp.spawn_count &&
      runnerCalls === 0 && rec.error?.includes(exp.code);
    if (!ok) reasons.push("MISMATCH vs expected_outcome — SAFETY CRITICAL bila lolos");
    return { ok, reasons, meta: { mechanism: "scanSpecForbidden pre-spawn", spawn_count: mgr.spawnCount, safety_critical: true } };
  },

  /** Allowlist deny: repo di luar allowlist → runTask REPO_NOT_ALLOWED tanpa spawn. */
  async repo_allowlist(c) {
    const { runTask } = await import("../../packages/omp-bridge/dist/index.js");
    const res = await runTask(
      { task_id: "gs_al", lane: "debug", objective: "x", files_owned: [], requirements: [], acceptance_criteria: ["ok"], boundaries: [], verification_steps: [] },
      "/tmp/definitely-not-allowed-repo",
      { allowlist: [], mock: true },
    );
    const ok = res.status === "error" && res.code === c.expected_outcome.code;
    const reasons = [`runTask → ${res.status}/${res.code}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "bridge allowlist default-deny", safety_critical: true } };
  },

  /** Idempotensi: delegate ganda task_id sama → 1 spawn. */
  async delegate_idempotent(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    let runnerCalls = 0;
    const mgr = new WorkerManager({
      store,
      allowlist: [t.dir],
      runner: async () => { runnerCalls += 1; await new Promise((r) => setTimeout(r, 20)); return okRunner.run(); },
      onWorkerReady: (id) => { store.transition(id, "done", { summary: "ok" }); },
    });
    store.createTask({ task_id: "gs_dup", lane: "debug" });
    const spec = { task_id: "gs_dup", lane: "debug", objective: "x", files_owned: [], requirements: [], acceptance_criteria: ["ok"], boundaries: [], verification_steps: [] };
    await mgr.spawnTask("gs_dup", t.dir, { spec });
    await mgr.spawnTask("gs_dup", t.dir, { spec }); // retry ganda dari front
    await mgr.drain();
    const nTasks = store.listTasks().length;
    mgr.stop();
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const exp = c.expected_outcome;
    const ok = runnerCalls === exp.spawn_count && nTasks === exp.task_count;
    const reasons = [`runnerCalls=${runnerCalls} tasks=${nTasks}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "single-writer store + spawn dedupe" } };
  },

  /** Restart: running basi → recoverStale → failed/STALE_HEARTBEAT, data utuh. */
  async restart_recovery(c) {
    const t = tmpDb(c.id);
    let now = 5_000_000;
    const store = new TaskStore({ dbPath: t.db, now: () => now });
    store.createTask({ task_id: "gs_stale", lane: "debug" });
    store.transition("gs_stale", "running");
    store.createTask({ task_id: "gs_kept", lane: "qa" });
    now += 120_000;
    const mgr = new WorkerManager({ store, allowlist: [t.dir], runner: okRunner.run, staleTtlSeconds: 60 });
    const { recovered } = await mgr.start();
    const stale = store.getTask("gs_stale");
    const kept = store.getTask("gs_kept");
    mgr.stop();
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const exp = c.expected_outcome;
    const ok = recovered.includes("gs_stale") && stale.status === exp.status && stale.error === exp.error && kept.status === "queued";
    const reasons = [`recovered=[${recovered.join(",")}] stale=${stale.status}/${stale.error} kept=${kept.status}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "recoverStale (SQLite survive restart)" } };
  },

  /** Disconnect: hasil terminal outbox → drain 1× → delivered, tanpa dobel. */
  async disconnect_resume(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    store.createTask({ task_id: "gs_dc", lane: "debug" });
    store.transition("gs_dc", "running");
    store.transition("gs_dc", "done", { summary: "selesai saat offline" }); // client "hilang"
    const first = store.drainNotify();
    const second = store.drainNotify();
    const st = store.checkTaskStatus(["gs_dc"]);
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const exp = c.expected_outcome;
    const ok = first.length === exp.delivered_count && second.length === 0 && st.tasks["gs_dc"]?.status === "done";
    const reasons = [`drain1=${first.length} drain2=${second.length} status=${st.tasks["gs_dc"]?.status}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "notify_outbox delivered flag (dedupe)" } };
  },

  /** State machine: transisi invalid ditolak (done→running). */
  async invalid_transition(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    store.createTask({ task_id: "gs_tr", lane: "debug" });
    store.transition("gs_tr", "running");
    store.transition("gs_tr", "done", { summary: "ok" });
    let rejected = "";
    try {
      store.transition("gs_tr", "running");
    } catch (err) {
      rejected = err.code ?? String(err);
    }
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const ok = rejected === c.expected_outcome.error_code;
    const reasons = [`done→running → ${rejected || "DITERIMA (BUG)"}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "canTransition state machine" } };
  },

  /** Summary > 200 kata ditolak (kontrak voice). */
  async summary_limit(c) {
    const t = tmpDb(c.id);
    const store = new TaskStore({ dbPath: t.db });
    store.createTask({ task_id: "gs_sum", lane: "debug" });
    store.transition("gs_sum", "running");
    let rejected = "";
    try {
      store.transition("gs_sum", "done", { summary: Array(201).fill("kata").join(" ") });
    } catch (err) {
      rejected = err.code ?? String(err);
    }
    const rec = store.getTask("gs_sum");
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const ok = rejected === c.expected_outcome.error_code && rec.status === "running";
    const reasons = [`summary 201 kata → ${rejected || "DITERIMA (BUG)"}; status tetap ${rec.status}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "assertSummaryOk layer API" } };
  },

  /** Tanpa perubahan: worker branch kosong → merge gate "empty" tetap hijau + done. */
  async no_change_done(c) {
    const t = tmpDb(c.id);
    const repoDir = join(t.dir, "repo");
    const sideDir = join(t.dir, "side"); // artifact/worktree DI LUAR repo (main harus bersih)
    // buat repo git kecil deterministik untuk verifier `true`
    execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "gs"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "gs@local"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-q", "--allow-empty", "-m", "init"], { stdio: "pipe" });
    const store = new TaskStore({ dbPath: t.db });
    store.createTask({ task_id: "gs_nc", lane: "debug" });
    store.transition("gs_nc", "running");
    const orch = new MergeOrchestrator({ store, verifierCmd: "true", artifactDirBase: join(sideDir, "artifacts"), worktreeBase: join(sideDir, "wt") });
    const res = await orch.mergeTask("gs_nc", repoDir);
    const rec = store.getTask("gs_nc");
    store.close();
    rmSync(t.dir, { recursive: true, force: true });
    const exp = c.expected_outcome;
    const ok = (res.status === exp.merge_status) && rec.status === exp.status;
    const reasons = [`merge=${res.status} store=${rec.status}`];
    if (!ok) reasons.push("MISMATCH vs expected_outcome");
    return { ok, reasons, meta: { mechanism: "merge gate empty-merge (verifier tetap jalan)" } };
  },
};

/**
 * Jalankan satu kasus. Crash runner (bukan kegagalan task) → runner_error=true
 * dan dihitung failed (TASK-3.3 requirement 2 error case).
 */
export async function runCase(c) {
  const action = c.harness?.action;
  if (!action || !actions[action]) {
    return { ok: false, runner_error: true, reasons: [`harness.action "${action}" tidak dikenal`], meta: {} };
  }
  try {
    const res = await actions[action](c);
    return { ...res, runner_error: false };
  } catch (err) {
    return {
      ok: false,
      runner_error: true,
      reasons: [`runner crash: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`],
      meta: {},
    };
  }
}

export { scanSpecForbidden, specTexts };
