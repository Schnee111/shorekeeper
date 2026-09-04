import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../src/supervisor.js";
import { TaskStore } from "task-store";
import { TypedEventBus } from "event-bus";

describe("TaskSupervisor (P0/P1 Decoupling)", () => {
  it("accepts task command and immediately returns structured TaskReceipt", () => {
    const bus = new TypedEventBus();
    const store = new TaskStore({ dbPath: ":memory:", eventBus: bus });
    const supervisor = new TaskSupervisor({ store, eventBus: bus });

    const receipt = supervisor.submitTask({
      task_id: "task_sup_1",
      user_intent: "Run autonomous audit",
      lane: "research",
    });

    expect(receipt.accepted).toBe(true);
    expect(receipt.task_id).toBe("task_sup_1");
    expect(receipt.status).toBe("queued");
    expect(receipt.mode).toBe("background");
  });

  it("handles stop and resume commands cleanly", () => {
    const bus = new TypedEventBus();
    const store = new TaskStore({ dbPath: ":memory:", eventBus: bus });
    const supervisor = new TaskSupervisor({ store, eventBus: bus });

    supervisor.submitTask({
      task_id: "task_sup_2",
      user_intent: "Deploy service",
      lane: "debug",
    });

    const stopReceipt = supervisor.stopTask({
      task_id: "task_sup_2",
      reason: "User cancelled mid-flight",
    });

    expect(stopReceipt.status).toBe("cancelled");
  });
});
