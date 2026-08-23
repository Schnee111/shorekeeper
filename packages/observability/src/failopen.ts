/**
 * failopen.ts — eksportir fail-open (TASK-3.1 requirement 1 error case).
 *
 * Kolektor mati / eksport gagal → warning log + lanjutkan: tracing TIDAK BOLEH
 * menghentikan orkestrasi (assertion TASK-3.1: "Kolektor boleh mati — orkestrasi
 * harus survive (fail-open)"). Exporter OTLP asli me-reject/retry; wrapper ini
 * menelan semua kegagalan dan me-return SUCCESS semu ke processor.
 */
import type { ExportResult } from "@opentelemetry/core";
import {
  type AggregationOption,
  type AggregationTemporality,
  type InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

const OK_RESULT: ExportResult = { code: 0 }; // ExportResultCode.SUCCESS = 0

/** Hitung eksport sukses/total (dipakai test "eksport ke endpoint mati tidak crash"). */
export const failOpenStats = { exportAttempts: 0, exportOk: 0, exportFailed: 0 };

export function resetFailOpenStats(): void {
  failOpenStats.exportAttempts = 0;
  failOpenStats.exportOk = 0;
  failOpenStats.exportFailed = 0;
}

/** Wrapper SpanExporter: semua kegagalan ditelan + warning (sekali).
 *  DEADLINE: inner exporter (OTLP retry/backoff) tidak boleh menahan flush —
 *  lewat `timeoutMs` export dianggap gagal (fail-open) dan proses lanjut. */
export class FailOpenTraceExporter implements SpanExporter {
  private warned = false;
  constructor(private inner: SpanExporter, private timeoutMs = 2500) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    failOpenStats.exportAttempts += 1;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      failOpenStats.exportFailed += 1;
      if (!this.warned) {
        this.warned = true;
        console.warn(`[otel] trace export timeout ${this.timeoutMs}ms (kolektor mati?) — orkestrasi lanjut (fail-open)`);
      }
      resultCallback(OK_RESULT);
    }, this.timeoutMs);
    timer.unref?.();
    try {
      this.inner.export(spans, (result) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        if (result.code === 0) {
          failOpenStats.exportOk += 1;
          resultCallback(result);
        } else {
          failOpenStats.exportFailed += 1;
          if (!this.warned) {
            this.warned = true;
            console.warn(
              `[otel] trace export gagal (kolektor mati?) — orkestrasi lanjut (fail-open): ${String(result.error ?? "")}`.slice(0, 300),
            );
          }
          resultCallback(OK_RESULT); // fail-open: processor menganggap sukses
        }
      });
    } catch (err) {
      clearTimeout(timer);
      if (done) return;
      done = true;
      failOpenStats.exportFailed += 1;
      if (!this.warned) {
        this.warned = true;
        console.warn(`[otel] trace export throw — orkestrasi lanjut (fail-open): ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      }
      resultCallback(OK_RESULT);
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown().catch(() => undefined);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.().catch(() => undefined) ?? Promise.resolve();
  }
}

/** Wrapper PushMetricExporter: semua kegagalan ditelan + warning (sekali). */
export class FailOpenMetricExporter implements PushMetricExporter {
  private warned = false;
  constructor(private inner: PushMetricExporter) {}

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    failOpenStats.exportAttempts += 1;
    try {
      this.inner.export(metrics, (result) => {
        if (result.code === 0) {
          failOpenStats.exportOk += 1;
          resultCallback(result);
        } else {
          failOpenStats.exportFailed += 1;
          if (!this.warned) {
            this.warned = true;
            console.warn(
              `[otel] metric export gagal (kolektor mati?) — orkestrasi lanjut (fail-open): ${String(result.error ?? "")}`.slice(0, 300),
            );
          }
          resultCallback(OK_RESULT);
        }
      });
    } catch (err) {
      failOpenStats.exportFailed += 1;
      if (!this.warned) {
        this.warned = true;
        console.warn(`[otel] metric export throw — orkestrasi lanjut (fail-open): ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      }
      resultCallback(OK_RESULT);
    }
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush().catch(() => undefined);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown().catch(() => undefined);
  }

  selectAggregation?(instrumentType: InstrumentType): AggregationOption {
    return this.inner.selectAggregation?.(instrumentType) ?? ({ type: 0 } as unknown as AggregationOption);
  }

  selectAggregationTemporality?(instrumentType: InstrumentType): AggregationTemporality {
    return this.inner.selectAggregationTemporality?.(instrumentType) ?? (0 as AggregationTemporality);
  }
}
