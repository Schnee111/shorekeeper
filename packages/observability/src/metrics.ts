/**
 * metrics.ts — instrumen metrics Shorekeeper (TASK-3.1 requirement 2).
 *
 * Kontrak nama (snake_case, versioned — jangan ubah in-place tanpa bump):
 * - counter   task_created_total
 * - counter   task_done_total
 * - counter   task_failed_total
 * - counter   task_retried_total
 * - counter   conflict_detected_total
 * - histogram worker_duration_seconds   (buckets 1s..900s)
 * - histogram merge_duration_seconds    (buckets 0.1s..600s)
 * - gauge     worker_pool_size          (jumlah worker aktif di pool)
 *
 * Label WAJIB valid: task_id/lane kosong atau bukan string → metric DI-DROP +
 * satu warning (jangan crash — observasi tidak boleh menghentikan orkestrasi).
 */
import type { Counter, Histogram, Meter, ObservableGauge } from "@opentelemetry/api";

export type LaneLabel = "research" | "frontend" | "debug" | "qa";
export const VALID_LANES: readonly string[] = ["research", "frontend", "debug", "qa"];

const BUCKETS_WORKER = [1, 5, 15, 30, 60, 120, 300, 900];
const BUCKETS_MERGE = [0.1, 0.5, 1, 5, 15, 30, 60, 120, 600];

/** Label valid untuk instrumen task: task_id non-kosong + lane dikenal. */
export function validLabels(taskId: unknown, lane: unknown): { task_id: string; lane: string } | null {
  if (typeof taskId !== "string" || taskId.trim().length === 0) return null;
  if (typeof lane !== "string" || !VALID_LANES.includes(lane)) return null;
  return { task_id: taskId.trim(), lane };
}

/** Callback pool size (diisi manager via setPoolSizeProvider). */
type PoolSizeProvider = () => number;
let poolSizeProvider: PoolSizeProvider | null = null;
let poolSizeWarned = false;

/** Provider global gauge worker_pool_size (WorkerManager memanggil ini saat init). */
export function setPoolSizeProvider(provider: PoolSizeProvider | null): void {
  poolSizeProvider = provider;
}

export class SkMetrics {
  readonly taskCreated: Counter;
  readonly taskDone: Counter;
  readonly taskFailed: Counter;
  readonly taskRetried: Counter;
  readonly conflictDetected: Counter;
  readonly workerDuration: Histogram;
  readonly mergeDuration: Histogram;
  readonly poolGauge: ObservableGauge;

  constructor(meter: Meter) {
    this.taskCreated = meter.createCounter("task_created_total", { description: "Task dibuat (seed/queue)" });
    this.taskDone = meter.createCounter("task_done_total", { description: "Task selesai sukses" });
    this.taskFailed = meter.createCounter("task_failed_total", { description: "Task gagal" });
    this.taskRetried = meter.createCounter("task_retried_total", { description: "Retry attempt worker" });
    this.conflictDetected = meter.createCounter("conflict_detected_total", {
      description: "Deteksi konflik ownership/merge",
    });
    this.workerDuration = meter.createHistogram("worker_duration_seconds", {
      description: "Durasi worker per attempt",
      unit: "s",
      advice: { explicitBucketBoundaries: BUCKETS_WORKER },
    });
    this.mergeDuration = meter.createHistogram("merge_duration_seconds", {
      description: "Durasi merge gate per task",
      unit: "s",
      advice: { explicitBucketBoundaries: BUCKETS_MERGE },
    });
    this.poolGauge = meter.createObservableGauge("worker_pool_size", {
      description: "Jumlah worker aktif di pool (slot terpakai)",
    });
    this.poolGauge.addCallback((result) => {
      if (!poolSizeProvider) {
        if (!poolSizeWarned) {
          poolSizeWarned = true;
          console.warn("[otel] gauge worker_pool_size tanpa provider (laporkan 0)");
        }
        result.observe(0);
        return;
      }
      try {
        result.observe(poolSizeProvider());
      } catch {
        result.observe(0);
      }
    });
  }

  private count(counter: Counter, taskId: unknown, lane: unknown): void {
    const labels = validLabels(taskId, lane);
    if (!labels) {
      if (!poolSizeWarned) console.warn(`[otel] metric label tidak valid (task_id=${String(taskId)}, lane=${String(lane)}) — drop + warn, bukan crash`);
      return;
    }
    counter.add(1, labels);
  }

  taskCreatedInc(taskId: unknown, lane: unknown): void {
    this.count(this.taskCreated, taskId, lane);
  }
  taskDoneInc(taskId: unknown, lane: unknown): void {
    this.count(this.taskDone, taskId, lane);
  }
  taskFailedInc(taskId: unknown, lane: unknown): void {
    this.count(this.taskFailed, taskId, lane);
  }
  taskRetriedInc(taskId: unknown, lane: unknown): void {
    this.count(this.taskRetried, taskId, lane);
  }
  conflictInc(taskId: unknown, lane: unknown): void {
    this.count(this.conflictDetected, taskId, lane);
  }

  /** Record durasi worker (detik). Label invalid → drop + warn. */
  workerDurationSeconds(seconds: number, taskId: unknown, lane: unknown): void {
    const labels = validLabels(taskId, lane);
    if (!labels) return;
    this.workerDuration.record(Math.max(0, seconds), labels);
  }
  mergeDurationSeconds(seconds: number, taskId: unknown, lane: unknown): void {
    const labels = validLabels(taskId, lane);
    if (!labels) return;
    this.mergeDuration.record(Math.max(0, seconds), labels);
  }
}
