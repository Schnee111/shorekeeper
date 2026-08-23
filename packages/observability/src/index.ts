/**
 * observability — OTel SDK setup Shorekeeper (TASK-3.1).
 *
 * - Tracer: OTLP/HTTP trace exporter → kolektor self-host (Jaeger via OTel
 *   Collector). Fail-open: kolektor mati → eksport gagal DITELAN + warning
 *   (tracing tidak boleh menghentikan orkestrasi — assertion TASK-3.1).
 * - Metrics: OTLP/HTTP metric exporter via PeriodicExportingMetricReader
 *   (interval pendek untuk CLI/E2E singkat; Prometheus scrape via collector).
 * - Service name: `shorekeeper-orchestrator` (query Jaeger/Prometheus pakai
 *   nama ini — lihat docs/observability.md).
 * - Privasi: sanitizeAttrs buang key transcript/user_said (spans.ts).
 */
import { metrics, trace, type MeterProvider as ApiMeterProvider } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { FailOpenMetricExporter, FailOpenTraceExporter } from "./failopen.js";
import { SkMetrics } from "./metrics.js";
import { TaskTracer } from "./spans.js";

export * from "./failopen.js";
export * from "./metrics.js";
export * from "./spans.js";

export const OBSERVABILITY_VERSION = "0.1.0";
export const SERVICE_NAME = "shorekeeper-orchestrator";

export interface ObservabilityOptions {
  /** Nama service OTel (default shorekeeper-orchestrator). */
  serviceName?: string;
  /** Versi service (attribute resource). */
  serviceVersion?: string;
  /**
   * Endpoint OTLP/HTTP. Default env OTEL_EXPORTER_OTLP_ENDPOINT atau
   * http://localhost:4318. Nilai `none` → tanpa remote exporter
   * (in-memory saja; dipakai unit test deterministik).
   */
  endpoint?: string;
  /** Interval export metrics ms (default 1000; E2E bisa lebih pendek). */
  metricIntervalMs?: number;
  /** Pakai InMemorySpanExporter (test/E2E assertion + gate privasi). */
  inMemory?: boolean;
  /** Max queue/batch span (kecil: proses CLI singkat). */
  maxQueueSize?: number;
  maxExportBatchSize?: number;
}

export interface ObservabilityHandle {
  tracer: TaskTracer;
  metrics: SkMetrics;
  /** Flush semua span/metric tertunda (panggil sebelum exit). */
  flush(): Promise<void>;
  /** Shutdown provider (akhir proses; flush dulu). */
  shutdown(): Promise<void>;
  /** In-memory exporter (hanya bila inMemory=true) — assertion test/E2E. */
  memoryExporter?: InMemorySpanExporter;
  /** Endpoint remote yang dipakai (`none` bila tanpa remote). */
  endpoint: string;
}

let activeHandle: ObservabilityHandle | null = null;

/**
 * Inisialisasi OTel (idempotent per proses — handle tunggal global).
 * Gagal koneksi kolektor BUKAN error: eksportir fail-open (failopen.ts).
 */
export function initObservability(opts: ObservabilityOptions = {}): ObservabilityHandle {
  if (activeHandle) return activeHandle;

  const serviceName = opts.serviceName ?? SERVICE_NAME;
  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": opts.serviceVersion ?? OBSERVABILITY_VERSION,
  });

  const endpoint = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  const remote = endpoint !== "none";
  const memoryExporter = opts.inMemory ? new InMemorySpanExporter() : undefined;

  const spanProcessors = [];
  const exporters: SpanExporter[] = [];
  if (remote) {
    exporters.push(new FailOpenTraceExporter(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` })));
  }
  if (memoryExporter) exporters.push(memoryExporter);
  for (const exp of exporters) {
    // in-memory: SimpleSpanProcessor (deterministik — span langsung tersedia).
    // remote: BatchSpanProcessor (tidak memblokir orkestrasi).
    spanProcessors.push(
      exp === memoryExporter
        ? new SimpleSpanProcessor(exp)
        : new BatchSpanProcessor(exp, {
            maxQueueSize: opts.maxQueueSize ?? 512,
            maxExportBatchSize: opts.maxExportBatchSize ?? 64,
            scheduledDelayMillis: 500,
          }),
    );
  }

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors,
    // CLI/E2E singkat: jangan tunggu 30s (default) saat flush sebelum exit.
    forceFlushTimeoutMillis: 5000,
  });
  trace.setGlobalTracerProvider(tracerProvider);
  const tracer = tracerProvider.getTracer(serviceName, opts.serviceVersion ?? OBSERVABILITY_VERSION);

  const readers = [];
  if (remote) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new FailOpenMetricExporter(
          new OTLPMetricExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/metrics` }),
        ),
        exportIntervalMillis: opts.metricIntervalMs ?? 1000,
        exportTimeoutMillis: Math.max(500, Math.floor((opts.metricIntervalMs ?? 1000) / 2)),
      }),
    );
  }
  const meterProvider: ApiMeterProvider & { forceFlush(): Promise<void>; shutdown(): Promise<void> } =
    new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);
  const meter = meterProvider.getMeter(serviceName, opts.serviceVersion ?? OBSERVABILITY_VERSION);
  const skMetrics = new SkMetrics(meter);

  activeHandle = {
    tracer: new TaskTracer(tracer),
    metrics: skMetrics,
    memoryExporter,
    endpoint: remote ? endpoint : "none",
    flush: async () => {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    shutdown: async () => {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
      activeHandle = null;
    },
  };
  return activeHandle;
}

/** Handle aktif bila sudah init (null bila belum). */
export function getObservability(): ObservabilityHandle | null {
  return activeHandle;
}

/** Reset handle global (khusus test). */
export function resetObservabilityForTest(): void {
  activeHandle = null;
}
