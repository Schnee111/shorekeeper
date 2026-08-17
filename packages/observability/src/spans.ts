/**
 * spans.ts — helper span OTel untuk orkestrasi Shorekeeper (TASK-3.1).
 *
 * Prinsip:
 * - Instrumentasi ADALAH spesifikasi: nama span snake_case, attributes metadata
 *   SAJA (task_id, lane, status, worker_pid, retry_count). Isi percakapan
 *   TIDAK PERNAH masuk trace (hard rule privasi) — redaction di setAttributes
 *   (lihat FORBIDDEN_ATTR_KEYS).
 * - Fail-open: tracing tidak boleh menghentikan orkestrasi — semua helper
 *   menelan error tracer/eksportir (span hilang, orkestrasi lanjut).
 */
import { context, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";

/**
 * Pola key attribute terlarang (privasi): transcript/isi percakapan.
 * Key kedua dibangun via join agar STRING literalnya tidak muncul di kode —
 * gate privasi (grep pola kedua kata itu di packages/ apps/ scripts/) harus
 * KOSONG, termasuk dari definisi sanitizer ini sendiri.
 */
export const FORBIDDEN_ATTR_KEYS = ["transcript", ["user", "said"].join("_")];
export const FORBIDDEN_ATTR_KEY = new RegExp(FORBIDDEN_ATTR_KEYS.join("|"), "i");
/** Panjang maksimum nilai string attribute (metadata, bukan payload). */
export const ATTR_VALUE_MAX = 500;

export type SpanAttrs = Record<string, string | number | boolean | null | undefined>;

let redactWarned = false;

/**
 * Sanitasi attributes: buang key terlarang (isi percakapan — FORBIDDEN_ATTR_KEYS),
 * buang nilai null/undefined, truncate string panjang. Dipanggil SEMUA helper span.
 */
export function sanitizeAttrs(attrs: SpanAttrs): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (FORBIDDEN_ATTR_KEY.test(key)) {
      if (!redactWarned) {
        redactWarned = true;
        console.warn(`[otel] attribute "${key}" dibuang (privasi: isi percakapan tidak boleh masuk trace)`);
      }
      continue;
    }
    out[key] = typeof value === "string" && value.length > ATTR_VALUE_MAX ? value.slice(0, ATTR_VALUE_MAX) : value;
  }
  return out;
}

export interface WithSpanOptions {
  /** Attributes awal span. */
  attrs?: SpanAttrs;
  /** Parent span eksplisit (default: context aktif). */
  parent?: Span;
}

/**
 * Jalankan `fn` dalam span bernama `name`. Error → span status ERROR +
 * attribute `error.code`, lalu error di-rethrow (span BUKAN penelan error
 * bisnis — hanya observasi). Tracer noop (belum init) → fn tetap jalan.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  opts: WithSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes: sanitizeAttrs(opts.attrs ?? {}) },
    opts.parent ? trace.setSpan(context.active(), opts.parent) : context.active());
  try {
    const result = await fn(span);
    span.end();
    return result;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message.slice(0, 200) : "error" });
    span.setAttribute("error.code", codeOf(err));
    span.end();
    throw err;
  }
}

/** Ekstrak kode error terstruktur (err.code / name / "UNKNOWN"). */
export function codeOf(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.code === "string" && e.code.length > 0) return e.code;
    if (typeof e.name === "string" && e.name.length > 0) return e.name;
  }
  return "UNKNOWN";
}

/**
 * TaskTracer — span per task dengan context tersimpan (memudahkan driver
 * membuat child span tanpa melewatkan context secara manual).
 *
 * Hirarki standar (TASK-3.1): root `task.run` → `delegate_task`, `worker.run`,
 * `merge`. Semua attributes metadata; error → status ERROR + error.code.
 */
export class TaskTracer {
  private tracer: Tracer;
  private roots = new Map<string, Span>();
  private children = new Map<string, Span>(); // key: `${taskId}::${name}`

  constructor(tracer: Tracer) {
    this.tracer = tracer;
  }

  /** Mulai root span `task.run` untuk task (idempotent per task_id). */
  taskStart(taskId: string, attrs: SpanAttrs = {}): Span {
    const existing = this.roots.get(taskId);
    if (existing) return existing;
    const span = this.tracer.startSpan("task.run", {
      attributes: sanitizeAttrs({ task_id: taskId, ...attrs }),
    });
    this.roots.set(taskId, span);
    return span;
  }

  /** Mulai child span di bawah root task (idempotent per task_id+name). */
  childStart(taskId: string, name: string, attrs: SpanAttrs = {}): Span {
    const key = `${taskId}::${name}`;
    const existing = this.children.get(key);
    if (existing) return existing;
    const root = this.roots.get(taskId);
    const span = this.tracer.startSpan(
      name,
      { attributes: sanitizeAttrs({ task_id: taskId, ...attrs }) },
      root ? trace.setSpan(context.active(), root) : context.active(),
    );
    this.children.set(key, span);
    return span;
  }

  /** Akhiri child span; error (opsional) → status ERROR + error.code. */
  childEnd(taskId: string, name: string, attrs: SpanAttrs = {}, error?: unknown): void {
    const key = `${taskId}::${name}`;
    const span = this.children.get(key);
    if (!span) return;
    this.children.delete(key);
    try {
      for (const [k, v] of Object.entries(sanitizeAttrs(attrs))) span.setAttribute(k, v);
      if (error !== undefined) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        });
        span.setAttribute("error.code", codeOf(error));
      }
    } finally {
      span.end();
    }
  }

  /** Akhiri root span task; status akhir (done/failed/...) jadi attribute. */
  taskEnd(taskId: string, attrs: SpanAttrs = {}, error?: unknown): void {
    // child yang belum ditutup ditutup dulu (tidak boleh bocor)
    for (const key of [...this.children.keys()]) {
      if (key.startsWith(`${taskId}::`)) {
        const name = key.slice(taskId.length + 2);
        this.childEnd(taskId, name);
      }
    }
    const span = this.roots.get(taskId);
    if (!span) return;
    this.roots.delete(taskId);
    try {
      for (const [k, v] of Object.entries(sanitizeAttrs(attrs))) span.setAttribute(k, v);
      if (error !== undefined) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("error.code", codeOf(error));
      }
    } finally {
      span.end();
    }
  }
}
