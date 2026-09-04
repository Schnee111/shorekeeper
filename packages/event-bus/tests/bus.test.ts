import { describe, it, expect, vi } from "vitest";
import { TypedEventBus, TaskEvent } from "../src/index.js";

describe("TypedEventBus", () => {
  it("publishes and delivers typed events to specific subscribers", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    const unsubscribe = bus.subscribe("task.completed", handler);

    const event: TaskEvent<{ summary: string }> = {
      eventId: "evt_1",
      eventType: "task.completed",
      taskId: "task_1",
      rootTaskId: "task_1",
      ownerId: "user_shnee",
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: { summary: "Refactored event bus" },
    };

    bus.publish(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);

    unsubscribe();
    bus.publish({
      ...event,
      eventId: "evt_2",
      sequence: 2,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("wildcard subscribeAll receives all event types", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.subscribeAll(handler);

    const event1: TaskEvent = {
      eventId: "evt_1",
      eventType: "task.started",
      taskId: "task_1",
      rootTaskId: "task_1",
      ownerId: "user_shnee",
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: {},
    };

    const event2: TaskEvent = {
      eventId: "evt_2",
      eventType: "task.completed",
      taskId: "task_1",
      rootTaskId: "task_1",
      ownerId: "user_shnee",
      sequence: 2,
      timestamp: new Date().toISOString(),
      payload: {},
    };

    bus.publish(event1);
    bus.publish(event2);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, event1);
    expect(handler).toHaveBeenNthCalledWith(2, event2);
  });

  it("detects sequence gaps per task", () => {
    const onGap = vi.fn();
    const bus = new TypedEventBus({ onSequenceGap: onGap });

    const event1: TaskEvent = {
      eventId: "evt_1",
      eventType: "task.started",
      taskId: "task_A",
      rootTaskId: "task_A",
      ownerId: "user_shnee",
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: {},
    };

    const event3: TaskEvent = {
      eventId: "evt_3",
      eventType: "task.completed",
      taskId: "task_A",
      rootTaskId: "task_A",
      ownerId: "user_shnee",
      sequence: 3, // Skipped 2
      timestamp: new Date().toISOString(),
      payload: {},
    };

    bus.publish(event1);
    expect(onGap).not.toHaveBeenCalled();

    bus.publish(event3);
    expect(onGap).toHaveBeenCalledTimes(1);
    expect(onGap).toHaveBeenCalledWith(2, 3, event3);
  });

  it("throws validation error on invalid event schema", () => {
    const bus = new TypedEventBus();

    const invalidEvent = {
      eventId: "",
      eventType: "invalid.type" as any,
      taskId: "task_1",
      sequence: -1,
    };

    expect(() => bus.publish(invalidEvent as any)).toThrow();
  });
});
