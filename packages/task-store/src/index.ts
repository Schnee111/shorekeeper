/**
 * task-store — index publik (TASK-1.4).
 */
export { STORE_VERSION, DEFAULT_DB_PATH, MAX_ARTIFACT_INLINE_BYTES, countWords } from "./store.js";
export { TaskStore, TaskStoreError } from "./store.js";
export type {
  TaskStoreOptions,
  TransitionMeta,
  TouchHeartbeatResult,
  CheckTaskStatusEntry,
  CheckTaskStatusResult,
  NotifyOutboxEntry,
} from "./store.js";
export { TypedEventBus, type TaskEvent, type TaskEventType } from "event-bus";