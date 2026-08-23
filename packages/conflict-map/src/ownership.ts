/**
 * ownership.ts — file ownership map one-file-one-owner (TASK-2.3).
 *
 * `data/ownership.json` adalah sumber klaim file antar task: satu file satu
 * owner. Klaim di-seed dari contract (spec.files_owned) saat dekomposisi task;
 * worker manager cek SEBELUM spawn (pre-spawn), merge orchestrator cek ulang
 * sebelum merge (merge-tree, defense-in-depth).
 *
 * API:
 * - `claimFiles(taskId, paths[])` → `{ status: "ok" }` ATAU
 *   `{ status: "conflict", conflictsWith: [taskIds] }`. Klaim yang bentrok
 *   TIDAK overwrite klaim aktif pemilik — klaim baru dicatat sebagai
 *   `pending` (intent) dan hanya menjadi `active` lewat re-claim setelah
 *   owner release.
 * - `conflictsWith(taskId)` → task lain yang overlap file (memenuhi kontrak
 *   OwnershipLike worker manager — hanya owner AKTIF yang men-defer spawn).
 * - `release(taskId)` → lepas klaim saat task done/cancelled/failed.
 *
 * Alert & metric: tiap deteksi menulis line log
 * `conflict-detected <taskA> <taskB> files=[...]` + counter `conflict_detected`
 * di JSON (dipakai TASK-3.1 metrics). Detection over resolution: false
 * positive > false negative.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OwnershipClaim {
  files: string[];
  claimed_at: number;
  /** active = memegang file; pending = intent terblokir (menunggu owner release). */
  status: "active" | "pending" | "released";
}

export interface OwnershipFile {
  version: 1;
  claims: Record<string, OwnershipClaim>;
  counters: { conflict_detected: number };
  log: string[];
}

export interface OwnershipMapOptions {
  /** Path persistence (default tanpa persist — in-memory saja). */
  filePath?: string;
  /** Sumber waktu (injectable test). */
  now?: () => number;
  /**
   * Filter owner aktif untuk conflictsWith (default: semua klaim active).
   * E2E memakai `(id) => store.getTask(id)?.status === "running"` agar hanya
   * owner yang SEDANG RUNNING yang men-defer spawn (kontrak OwnershipLike).
   */
  isActive?: (taskId: string) => boolean;
  /** Callback alert per deteksi (driver menulis ke log stdout). */
  onConflict?: (taskA: string, taskB: string, files: string[]) => void;
}

export type ClaimResult =
  | { status: "ok" }
  | { status: "conflict"; conflictsWith: string[] };

const EMPTY: OwnershipFile = {
  version: 1,
  claims: {},
  counters: { conflict_detected: 0 },
  log: [],
};

export class OwnershipMap {
  private state: OwnershipFile;
  private filePath: string | null;
  private now: () => number;
  private isActive: (taskId: string) => boolean;
  private onConflict?: (taskA: string, taskB: string, files: string[]) => void;
  /** Pair yang sudah dilaporkan (hindari counter ganda untuk deteksi yang sama). */
  private reportedPairs = new Set<string>();

  constructor(opts: OwnershipMapOptions = {}) {
    this.filePath = opts.filePath ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.isActive = opts.isActive ?? (() => true);
    this.onConflict = opts.onConflict;
    this.state = this.load();
  }

  private load(): OwnershipFile {
    if (this.filePath && existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<OwnershipFile>;
        return {
          version: 1,
          claims: parsed.claims ?? {},
          counters: { conflict_detected: parsed.counters?.conflict_detected ?? 0 },
          log: parsed.log ?? [],
        };
      } catch {
        return structuredClone(EMPTY);
      }
    }
    return structuredClone(EMPTY);
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  /** Normalisasi path file: slash tunggal, tanpa leading "./". */
  static normalize(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  }

  private claimRecord(taskId: string): OwnershipClaim | null {
    const c = this.state.claims[taskId];
    return c && c.status !== "released" ? c : null;
  }

  /**
   * Klaim file untuk task. Bentrok dengan klaim AKTIF task lain →
   * `{ status: "conflict", conflictsWith }`; klaim pemilik TIDAK di-overwrite
   * (klaim baru dicatat `pending`). Klaim ulang setelah owner release → `ok`
   * dan naik menjadi `active`.
   */
  claimFiles(taskId: string, paths: string[]): ClaimResult {
    const files = [...new Set(paths.map((p) => OwnershipMap.normalize(p)))];
    const conflicting = new Set<string>();
    for (const f of files) {
      for (const [otherId, claim] of Object.entries(this.state.claims)) {
        if (otherId === taskId || claim.status !== "active") continue;
        if (claim.files.includes(f)) conflicting.add(otherId);
      }
    }
    if (conflicting.size > 0) {
      this.state.claims[taskId] = { files, claimed_at: this.now(), status: "pending" };
      const owners = [...conflicting].sort();
      for (const owner of owners) this.noteConflict(taskId, owner);
      this.persist();
      return { status: "conflict", conflictsWith: owners };
    }
    this.state.claims[taskId] = { files, claimed_at: this.now(), status: "active" };
    this.persist();
    return { status: "ok" };
  }

  /**
   * Task lain dengan klaim AKTIF yang overlap file dengan `taskId` (memenuhi
   * kontrak OwnershipLike worker manager: hanya owner aktif yang men-defer).
   * Deterministik (sorted).
   */
  conflictsWith(taskId: string): string[] {
    const mine = this.claimRecord(taskId);
    if (!mine) return [];
    const owners: string[] = [];
    for (const [otherId, claim] of Object.entries(this.state.claims)) {
      if (otherId === taskId || claim.status !== "active") continue;
      if (!this.isActive(otherId)) continue;
      if (mine.files.some((f) => claim.files.includes(f))) owners.push(otherId);
    }
    return owners.sort();
  }

  /** File overlap antara dua task (untuk line log `files=[...]`). */
  overlapFiles(taskA: string, taskB: string): string[] {
    const a = this.claimRecord(taskA);
    const b = this.claimRecord(taskB);
    if (!a || !b) return [];
    return a.files.filter((f) => b.files.includes(f)).sort();
  }

  /** Lepas klaim (task done/cancelled/failed) — idempotent. */
  release(taskId: string): void {
    const claim = this.state.claims[taskId];
    if (!claim) return;
    claim.status = "released";
    this.persist();
  }

  /** Deteksi eksplisit (dipanggil driver saat defer/overlap) — idempotent per pair. */
  noteConflict(taskA: string, taskB: string): void {
    const [a, b] = taskA < taskB ? [taskA, taskB] : [taskB, taskA];
    const key = `${a}::${b}`;
    if (this.reportedPairs.has(key)) return;
    this.reportedPairs.add(key);
    const overlap = this.overlapFiles(a, b);
    const line = `conflict-detected ${taskA} ${taskB} files=[${overlap.join(",")}]`;
    this.state.log.push(line);
    this.state.counters.conflict_detected += 1;
    this.persist();
    this.onConflict?.(taskA, taskB, overlap);
  }

  /** Line log `conflict-detected ...` (untuk assertion E2E). */
  conflictLog(): string[] {
    return [...this.state.log];
  }

  /** Counter deteksi (metrik TASK-3.1). */
  conflictCount(): number {
    return this.state.counters.conflict_detected;
  }

  /** Klaim aktif sebuah task (null bila tidak ada / pending / released). */
  claimOf(taskId: string): OwnershipClaim | null {
    const c = this.state.claims[taskId];
    return c && c.status === "active" ? c : null;
  }

  /** Klaim aktif + pending (untuk debugging/E2E). */
  allClaims(): Record<string, OwnershipClaim> {
    return { ...this.state.claims };
  }
}
