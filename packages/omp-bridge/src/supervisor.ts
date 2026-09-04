import { TaskStore } from "task-store";
import { TypedEventBus } from "event-bus";
import {
  CreateTaskCommand,
  CreateTaskCommandSchema,
  StopTaskCommand,
  StopTaskCommandSchema,
  ResumeTaskCommand,
  ResumeTaskCommandSchema,
  TaskReceipt,
} from "handoff-contract";

export interface TaskSupervisorOptions {
  store: TaskStore;
  eventBus: TypedEventBus;
}

export class TaskSupervisor {
  private store: TaskStore;
  private eventBus: TypedEventBus;

  constructor(opts: TaskSupervisorOptions) {
    this.store = opts.store;
    this.eventBus = opts.eventBus;
  }

  public submitTask(cmd: CreateTaskCommand): TaskReceipt {
    const validated = CreateTaskCommandSchema.parse(cmd);
    const rec = this.store.createTask({
      task_id: validated.task_id,
      session_room: validated.session_room,
      user_intent: validated.user_intent,
      lane: validated.lane,
      parent_id: validated.parent_id ?? null,
      root_task_id: validated.root_task_id ?? (validated.parent_id ?? validated.task_id),
      priority: validated.priority,
      status: "queued",
    });

    return {
      accepted: true,
      task_id: rec.task_id,
      status: rec.status,
      mode: "background",
      created_at: rec.created_at,
    };
  }

  public stopTask(cmd: StopTaskCommand): TaskReceipt {
    const validated = StopTaskCommandSchema.parse(cmd);
    const rec = this.store.transition(validated.task_id, "cancelled", {
      error: validated.reason,
    });

    return {
      accepted: true,
      task_id: rec.task_id,
      status: rec.status,
      mode: "background",
      created_at: rec.finished_at ?? Date.now(),
    };
  }

  public resumeTask(cmd: ResumeTaskCommand): TaskReceipt {
    const validated = ResumeTaskCommandSchema.parse(cmd);
    const rec = this.store.transition(validated.task_id, "running", {
      summary: `Resumed by user input: ${validated.user_response.slice(0, 100)}`,
    });

    return {
      accepted: true,
      task_id: rec.task_id,
      status: rec.status,
      mode: "background",
      created_at: rec.started_at ?? Date.now(),
    };
  }

  public getReceipt(taskId: string): TaskReceipt | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    return {
      accepted: true,
      task_id: task.task_id,
      status: task.status,
      mode: "background",
      created_at: task.created_at,
    };
  }
}
