import { z } from "zod";

export const TaskEventTypeSchema = z.enum([
  "task.accepted",
  "task.queued",
  "task.started",
  "task.progress",
  "task.waiting_input",
  "task.resumed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.unknown",
]);

export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

export const TaskEventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventType: TaskEventTypeSchema,
  taskId: z.string().min(1),
  rootTaskId: z.string().min(1),
  parentTaskId: z.string().nullable().optional(),
  ownerId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T.*Z$/)),
  payload: z.record(z.unknown()).default({}),
});

export type TaskEvent<T = Record<string, unknown>> = Omit<
  z.infer<typeof TaskEventEnvelopeSchema>,
  "payload"
> & {
  payload: T;
};
