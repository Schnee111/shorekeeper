/**
 * tests/edge — TASK-3.2 requirement 2: narasi error terstruktur.
 *
 * Kontrak front: `{ task_id, phase, code, retries_left }` + narasi natural
 * (pola riset §3.2: "Task X gagal di langkah Y — mau saya coba lagi?").
 */
import { describe, expect, it } from "vitest";
import { failureNarration, structuredError, PHASE_LABELS } from "../../src/errors.js";

describe("edge: narasi error terstruktur (TASK-3.2)", () => {
  it("structuredError bentuk kontrak { task_id, phase, code, retries_left }", () => {
    const err = structuredError({ taskId: "t9", phase: "worker", code: "TIMEOUT", retriesLeft: 2 });
    expect(err).toEqual({ task_id: "t9", phase: "worker", code: "TIMEOUT", retries_left: 2 });
  });

  it("retries_left tidak pernah negatif", () => {
    const err = structuredError({ taskId: "t9", phase: "merge", code: "VERIFY_FAILED", retriesLeft: -3 });
    expect(err.retries_left).toBe(0);
  });

  it("narasi ada sisa retry → ajakan coba lagi (pola riset)", () => {
    const err = structuredError({ taskId: "task_a", phase: "worker", code: "TIMEOUT", retriesLeft: 2 });
    const msg = failureNarration(err);
    expect(msg).toContain("task_a");
    expect(msg).toContain("gagal");
    expect(msg).toContain(PHASE_LABELS.worker);
    expect(msg).toContain("coba lagi");
    expect(msg).toContain("2");
  });

  it("narasi retry habis → pernyataan final tanpa ajakan", () => {
    const err = structuredError({ taskId: "task_b", phase: "merge", code: "VERIFY_FAILED", retriesLeft: 0 });
    const msg = failureNarration(err);
    expect(msg).toContain("task_b");
    expect(msg).toContain(PHASE_LABELS.merge);
    expect(msg).not.toContain("coba lagi?");
  });
});
