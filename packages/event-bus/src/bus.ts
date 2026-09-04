import EventEmitter from "node:events";
import {
  TaskEvent,
  TaskEventEnvelopeSchema,
  TaskEventType,
} from "./types.js";

export type EventHandler<T = Record<string, unknown>> = (
  event: TaskEvent<T>
) => void | Promise<void>;

export type SequenceGapCallback = (
  expectedSequence: number,
  actualSequence: number,
  event: TaskEvent
) => void;

export class TypedEventBus {
  private emitter: EventEmitter;
  private lastSequences: Map<string, number>;
  private onSequenceGap?: SequenceGapCallback;

  constructor(options?: { onSequenceGap?: SequenceGapCallback }) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.lastSequences = new Map();
    this.onSequenceGap = options?.onSequenceGap;
  }

  public publish<T = Record<string, unknown>>(rawEvent: TaskEvent<T>): TaskEvent<T> {
    const validated = TaskEventEnvelopeSchema.parse(rawEvent) as TaskEvent<T>;

    const lastSeq = this.lastSequences.get(validated.taskId);
    if (lastSeq !== undefined) {
      if (validated.sequence !== lastSeq + 1) {
        if (this.onSequenceGap) {
          this.onSequenceGap(lastSeq + 1, validated.sequence, validated as TaskEvent);
        }
      }
    }
    this.lastSequences.set(validated.taskId, validated.sequence);

    this.emitter.emit(validated.eventType, validated);
    this.emitter.emit("*", validated);

    return validated;
  }

  public subscribe<T = Record<string, unknown>>(
    eventType: TaskEventType,
    handler: EventHandler<T>
  ): () => void {
    const wrappedHandler = (event: TaskEvent<T>) => {
      try {
        const res = handler(event);
        if (res instanceof Promise) {
          res.catch((err) => {
            console.error(`[EventBus] Unhandled error in async handler for ${eventType}:`, err);
          });
        }
      } catch (err) {
        console.error(`[EventBus] Unhandled error in handler for ${eventType}:`, err);
      }
    };

    this.emitter.on(eventType, wrappedHandler as (...args: any[]) => void);

    return () => {
      this.emitter.off(eventType, wrappedHandler as (...args: any[]) => void);
    };
  }

  public subscribeAll(handler: EventHandler): () => void {
    const wrappedHandler = (event: TaskEvent) => {
      try {
        const res = handler(event);
        if (res instanceof Promise) {
          res.catch((err) => {
            console.error("[EventBus] Unhandled error in async wildcard handler:", err);
          });
        }
      } catch (err) {
        console.error("[EventBus] Unhandled error in wildcard handler:", err);
      }
    };

    this.emitter.on("*", wrappedHandler as (...args: any[]) => void);

    return () => {
      this.emitter.off("*", wrappedHandler as (...args: any[]) => void);
    };
  }

  public getSubscriberCount(eventType?: TaskEventType): number {
    if (!eventType) {
      return this.emitter.listenerCount("*");
    }
    return this.emitter.listenerCount(eventType);
  }

  public reset(): void {
    this.emitter.removeAllListeners();
    this.lastSequences.clear();
  }
}
