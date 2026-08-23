export { CONTRACT_VERSION } from "./contracts.js";
export {
  EntitySchema,
  HandoffSchema,
  TaskStatus,
  LANES,
  LaneSchema,
  TASK_TRANSITIONS,
  canTransition,
  summaryMaxWords,
  TaskRecordSchema,
  TaskSpecSchema,
} from "./contracts.js";

export type {
  Handoff,
  TaskStatus as TaskStatusType,
  TaskRecord,
  TaskSpec,
} from "./contracts.js";