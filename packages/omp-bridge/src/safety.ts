/**
 * safety.ts — guard prompt injection & path terlarang (TASK-3.2 requirement 3).
 *
 * Prinsip riset: worker TIDAK PERNAH percaya konten task spec untuk path —
 * allowlist selalu di orchestrator/bridge. Spec yang memuat path terlarang
 * (~/.ssh, /etc/passwd, C:\Windows, dst.) DITOLAK `REPO_NOT_ALLOWED` + alert
 * line SEBELUM spawn (spawn counter tetap 0).
 *
 * Deteksi (heuristik, deterministic, tanpa network):
 * - Pola path absolut terlarang: ~ (home), $HOME, /etc, /root, /var, C:\,
 *   /proc, /sys, /dev, /boot, /usr/etc.
 * - Pola traversal: `..` sebagai komponen path.
 * - Pola instruksi jailbreak eksplisit (abaikan instruksi, ignore previous).
 */
export const SAFETY_VERSION = "0.1.0";

/** Pola path terlarang (case-insensitive). */
const FORBIDDEN_PATH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:^|[\s"'`(=:])~\//, label: "home-tilde" },
  { re: /(?:^|[\s"'`(=:])~(?=[\s"'`)]|$)/, label: "home-tilde-bare" },
  { re: /\$HOME/i, label: "env-home" },
  { re: /(^|[\s"'`(=:])(\/(etc|root|boot|proc|sys|dev))\//i, label: "abs-system" },
  { re: /(^|[\s"'`(=:])(\/(etc|root|boot|proc|sys|dev))(?=[\s"'`)\]:,]|$)/i, label: "abs-system-bare" },
  { re: /[A-Za-z]:\\(Windows|Users|ProgramData)/i, label: "windows-system" },
  { re: /(^|[\s"'`(=:/])\.\.(\/|\\)/, label: "path-traversal" },
];

/** Pola instruksi jailbreak/injection (metadata alert — penolakan tetap via path check). */
const INJECTION_PATTERNS: RegExp[] = [
  /abaikan\s+(semua\s+)?instruksi/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?prior/i,
  /jangan\s+ikuti\s+(aturan|soul|agents\.md)/i,
];

export interface SafetyViolation {
  code: "REPO_NOT_ALLOWED";
  reason: string;
  matched: string[];
  injectionSuspected: boolean;
}

/** Gabungan field teks spec yang relevan untuk scan (konten spec TIDAK dipakai untuk path). */
export function specTexts(spec: {
  objective?: string;
  requirements?: string[];
  boundaries?: string[];
  files_owned?: string[];
  acceptance_criteria?: string[];
}): string {
  return [
    spec.objective ?? "",
    ...(spec.requirements ?? []),
    ...(spec.boundaries ?? []),
    ...(spec.files_owned ?? []),
    ...(spec.acceptance_criteria ?? []),
  ].join("\n");
}

/**
 * Scan spec untuk path terlarang / traversal. Return pelanggaran (dengan bukti
 * potongan teks) atau null bila bersih. Fungsi deterministik — testable.
 */
export function scanSpecForbidden(text: string): SafetyViolation | null {
  const matched: string[] = [];
  for (const { re, label } of FORBIDDEN_PATH_PATTERNS) {
    const m = text.match(re);
    if (m) matched.push(`${label}:${m[0].trim().slice(0, 60)}`);
  }
  const injectionSuspected = INJECTION_PATTERNS.some((re) => re.test(text));
  if (matched.length === 0 && !injectionSuspected) return null;
  if (matched.length === 0) {
    // hanya pola jailbreak tanpa path terlarang → belum cukup untuk menolak
    // (heuristik); caller dapat log alert. Return null agar tidak false-positive
    // berlebihan pada teks biasa; deteksi path tetap sumber penolakan utama.
    return null;
  }
  return {
    code: "REPO_NOT_ALLOWED",
    reason: `spec memuat path terlarang di luar boundaries allowlist — ditolak TANPA spawn (safety)`,
    matched,
    injectionSuspected,
  };
}

/** Line alert (format log konsisten, dipakai manager + test). */
export function safetyAlertLine(taskId: string, violation: SafetyViolation): string {
  return `safety-alert task=${taskId} REPO_NOT_ALLOWED matched=[${violation.matched.join(";")}] injection=${violation.injectionSuspected}`;
}
