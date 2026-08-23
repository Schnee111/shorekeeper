/**
 * Unit tests observability (TASK-3.1).
 *
 * Bukti acceptance:
 * - Privasi: sanitizeAttrs buang key transcript/user_said (hard rule).
 * - TaskTracer: root task.run → child span (parentTraceId == root traceId).
 * - Fail-open: eksportir mati → export gagal ditelan (orkestrasi tidak crash).
 * - Metrics: label invalid (task_id kosong / lane tak dikenal) → drop, bukan crash.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  FailOpenMetricExporter,
  FailOpenTraceExporter,
  FORBIDDEN_ATTR_KEY,
  initObservability,
  resetFailOpenStats,
  resetObservabilityForTest,
  sanitizeAttrs,
  validLabels,
} from "../src/index.js";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

afterEach(() => {
  resetObservabilityForTest();
  resetFailOpenStats();
});

describe("sanitizeAttrs — privasi trace (TASK-3.1)", () => {
  it("buang key transcript/user_said (pola FORBIDDEN_ATTR_KEY)", () => {
    expect(FORBIDDEN_ATTR_KEY.test("transcript")).toBe(true);
    expect(FORBIDDEN_ATTR_KEY.test("user_said")).toBe(true);
    expect(FORBIDDEN_ATTR_KEY.test("task_id")).toBe(false);
    const out = sanitizeAttrs({
      task_id: "t1",
      transcript: "isi percakapan rahasia",
      user_said: "halo",
      lane: "debug",
    });
    expect(out).toEqual({ task_id: "t1", lane: "debug" });
  });

  it("truncate nilai string panjang & buang null/undefined", () => {
    const out = sanitizeAttrs({ big: "x".repeat(900), kosong: null, undef: undefined, ok: 5 });
    expect((out.big as string).length).toBeLessThanOrEqual(500);
    expect("kosong" in out).toBe(false);
    expect("undef" in out).toBe(false);
    expect(out.ok).toBe(5);
  });
});

describe("TaskTracer — hirarki span task.run → child", () => {
  it("child span punya parentTraceId = traceId root; semua span satu trace", async () => {
    const handle = initObservability({ endpoint: "none", inMemory: true });
    handle.tracer.taskStart("t_root", { lane: "debug" });
    handle.tracer.childStart("t_root", "delegate_task", { attempt: 1 });
    handle.tracer.childEnd("t_root", "delegate_task", { status: "ok" });
    handle.tracer.childStart("t_root", "worker.run", { attempt: 1 });
    handle.tracer.childEnd("t_root", "worker.run", { exit_code: 0 });
    handle.tracer.taskEnd("t_root", { status: "done" });
    await handle.flush();

    const spans = handle.memoryExporter!.getFinishedSpans();
    const byName = new Map(spans.map((s) => [s.name, s]));
    expect(byName.has("task.run")).toBe(true);
    expect(byName.has("delegate_task")).toBe(true);
    expect(byName.has("worker.run")).toBe(true);
    const root = byName.get("task.run")!;
    const delegate = byName.get("delegate_task")!;
    const worker = byName.get("worker.run")!;
    expect(delegate.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(worker.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(delegate.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(worker.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    // metadata only: tidak ada attribute berisi isi percakapan
    for (const s of spans) {
      for (const key of Object.keys(s.attributes)) {
        expect(FORBIDDEN_ATTR_KEY.test(key)).toBe(false);
      }
    }
    await handle.shutdown();
  });

  it("taskEnd menutup child yang belum ditutup (tidak bocor)", async () => {
    const handle = initObservability({ endpoint: "none", inMemory: true });
    handle.tracer.taskStart("t_leak", { lane: "qa" });
    handle.tracer.childStart("t_leak", "merge");
    handle.tracer.taskEnd("t_leak", { status: "done" });
    await handle.flush();
    const names = handle.memoryExporter!.getFinishedSpans().map((s) => s.name);
    expect(names).toContain("merge");
    expect(names).toContain("task.run");
    await handle.shutdown();
  });
});

describe("Fail-open exporter — kolektor mati tidak menghentikan orkestrasi", () => {
  it("trace export gagal → callback tetap SUCCESS (fail-open)", () => {
    const broken: SpanExporter = {
      export(_spans: ReadableSpan[], cb: (r: { code: number }) => void) {
        cb({ code: 1 }); // ExportResultCode.FAILED
      },
      shutdown: () => Promise.resolve(),
    };
    const wrapped = new FailOpenTraceExporter(broken);
    let result: { code: number } | null = null;
    wrapped.export([], (r) => {
      result = r;
    });
    expect(result).not.toBeNull();
    expect(result!.code).toBe(0); // SUCCESS semu — orkestrasi lanjut
  });

  it("trace export throw → tetap SUCCESS, tidak melempar", () => {
    const broken: SpanExporter = {
      export() {
        throw new Error("ECONNREFUSED");
      },
      shutdown: () => Promise.resolve(),
    };
    const wrapped = new FailOpenTraceExporter(broken);
    let result: { code: number } | null = null;
    expect(() => wrapped.export([], (r) => (result = r))).not.toThrow();
    expect(result!.code).toBe(0);
  });

  it("metric export gagal → fail-open (callback SUCCESS)", () => {
    const broken = {
      export(_m: unknown, cb: (r: { code: number }) => void) {
        cb({ code: 1 });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    const wrapped = new FailOpenMetricExporter(broken as never);
    let result: { code: number } | null = null;
    wrapped.export({} as never, (r) => (result = r));
    expect(result!.code).toBe(0);
  });
});

describe("validLabels — metric label invalid drop + warn, bukan crash", () => {
  it("task_id kosong / lane tak dikenal → null (drop)", () => {
    expect(validLabels("", "debug")).toBeNull();
    expect(validLabels("  ", "debug")).toBeNull();
    expect(validLabels("t1", "bukan-lane")).toBeNull();
    expect(validLabels("t1", "debug")).toEqual({ task_id: "t1", lane: "debug" });
  });

  it("SkMetrics dengan label invalid tidak crash", async () => {
    const handle = initObservability({ endpoint: "none", inMemory: true });
    expect(() => handle.metrics.taskDoneInc("", "debug")).not.toThrow();
    expect(() => handle.metrics.taskFailedInc("t1", "lane-aneh")).not.toThrow();
    expect(() => handle.metrics.taskDoneInc("t1", "debug")).not.toThrow();
    await handle.shutdown();
  });
});
