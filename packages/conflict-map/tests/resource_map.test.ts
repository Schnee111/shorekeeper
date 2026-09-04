import { describe, it, expect } from "vitest";
import { ResourceConflictMap } from "../src/resource_map.js";

describe("ResourceConflictMap (Safe Dependency & Resource Admission)", () => {
  it("blocks admission if dependency task is not completed", () => {
    const rmap = new ResourceConflictMap();

    const result = rmap.canAdmit({
      taskId: "task_b",
      dependencies: ["task_a"],
      resources: ["repo:main"],
      mode: "exclusive",
    });

    expect(result.admitted).toBe(false);
    expect(result.reason).toContain("belum selesai");

    // Selesaikan task_a
    rmap.registerCompleted("task_a");

    const resultAfter = rmap.canAdmit({
      taskId: "task_b",
      dependencies: ["task_a"],
      resources: ["repo:main"],
      mode: "exclusive",
    });

    expect(resultAfter.admitted).toBe(true);
  });

  it("prevents resource collision when mode is exclusive", () => {
    const rmap = new ResourceConflictMap();

    rmap.claim({
      taskId: "task_1",
      dependencies: [],
      resources: ["db:schema"],
      mode: "exclusive",
    });

    const result = rmap.canAdmit({
      taskId: "task_2",
      dependencies: [],
      resources: ["db:schema"],
      mode: "exclusive",
    });

    expect(result.admitted).toBe(false);
    expect(result.reason).toContain("Resource conflict on: db:schema");
  });
});
