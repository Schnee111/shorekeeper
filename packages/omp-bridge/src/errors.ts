/**
 * errors.ts — narasi error terstruktur (TASK-3.2 requirement 2).
 *
 * Kontrak front (voice): kegagalan worker dilaporkan sebagai objek terstruktur
 * `{ task_id, phase, code, retries_left }` + narasi natural Bahasa Indonesia
 * (pola riset §3.2: "Task X gagal di langkah Y — mau saya coba lagi?").
 */

export type TaskPhase =
  | "delegate" // enqueue → ack
  | "worker" // eksekusi worker di worktree
  | "verify" // test suite
  | "merge"; // merge gate orchestrator

export interface StructuredTaskError {
  task_id: string;
  phase: TaskPhase;
  code: string;
  retries_left: number;
}

/** Label fase dalam Bahasa Indonesia (untuk narasi natural). */
export const PHASE_LABELS: Record<TaskPhase, string> = {
  delegate: "pendelegasian task",
  worker: "pengerjaan oleh worker",
  verify: "verifikasi hasil",
  merge: "penggabungan ke main",
};

/** Bangun error terstruktur dari kegagalan task (dipakai manager/front). */
export function structuredError(input: {
  taskId: string;
  phase: TaskPhase;
  code: string;
  retriesLeft: number;
}): StructuredTaskError {
  return {
    task_id: input.taskId,
    phase: input.phase,
    code: input.code,
    retries_left: Math.max(0, input.retriesLeft),
  };
}

/**
 * Narasi natural siap voice dari error terstruktur. Ada sisa retry → ajakan
 * mencoba lagi; habis → pernyataan gagal + saran eskalasi singkat.
 */
export function failureNarration(err: StructuredTaskError): string {
  const label = PHASE_LABELS[err.phase] ?? err.phase;
  if (err.retries_left > 0) {
    return `Task ${err.task_id} gagal di langkah ${label} (${err.code}) — mau saya coba lagi? Masih ada ${err.retries_left} percobaan.`;
  }
  return `Task ${err.task_id} gagal di langkah ${label} (${err.code}) dan semua percobaan sudah habis. Silakan periksa log atau coba ulang manual.`;
}
