import { describe, it, expect } from "vitest";
import { TaskStore } from "../src/store.js";
import { TypedEventBus, TaskEvent } from "event-bus";

describe("TaskStore Outbox Event Stream (P0-1)", () => {
  it("records outbox event on task creation and transitions", () => {
    const store = new TaskStore({ dbPath: ":memory:" });

    const task = store.createTask({
      task_id: "task_outbox_1",
      lane: "debug",
      user_intent: "Test outbox creation",
    });

    expect(task.status).toBe("queued");

    // Transition to running
    store.transition("task_outbox_1", "running");

    // Transition to done
    store.transition("task_outbox_1", "done", { summary: "Finished successfully" });

    // Drain outbox
    const events = store.drainOutbox();
    expect(events.length).toBe(3);

    expect(events[0].eventType).toBe("task.accepted");
    expect(events[0].sequence).toBe(1);

    expect(events[1].eventType).toBe("task.started");
    expect(events[1].sequence).toBe(2);

    expect(events[2].eventType).toBe("task.completed");
    expect(events[2].sequence).toBe(3);
    expect((events[2].payload as any).summary).toBe("Finished successfully");

    // Second drain should return empty (at-least-once + dedupe)
    expect(store.drainOutbox().length).toBe(0);
  });

  it("dispatches immediately to attached EventBus without manual drain", () => {
    const bus = new TypedEventBus();
    const receivedEvents: TaskEvent[] = [];

    bus.subscribeAll((event) => {
      receivedEvents.push(event);
    });

    const store = new TaskStore({ dbPath: ":memory:", eventBus: bus });

    store.createTask({
      task_id: "task_bus_1",
      lane: "research",
      user_intent: "Immediate dispatch test",
    });

    store.transition("task_bus_1", "running");

    expect(receivedEvents.length).toBe(2);
    expect(receivedEvents[0].eventType).toBe("task.accepted");
    expect(receivedEvents[1].eventType).toBe("task.started");

    // Because it was immediately published, drainOutbox returns empty
    expect(store.drainOutbox().length).toBe(0);
  });
});
