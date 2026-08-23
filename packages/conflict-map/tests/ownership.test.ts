/**
 * Unit test ownership map (TASK-2.3) — one-file-one-owner.
 *
 * Bukti acceptance:
 * - claim 2 task pada file sama → `conflict` terdeteksi (+ daftar pemilik);
 *   release → claim kedua berhasil; file berbeda → `ok`.
 * - klaim bentrok TIDAK overwrite klaim aktif pemilik (klaim baru `pending`).
 * - conflictsWith hanya menghitung owner AKTIF (filter isActive).
 * - noteConflict idempoten per pair + counter + line log format
 *   `conflict-detected <a> <b> files=[...]`.
 * - persistence: state selamat lewat reload dari file yang sama.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnershipMap } from "../src/ownership.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-own-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("OwnershipMap — claim/conflict/release (TASK-2.3)", () => {
  it("claim 2 task file sama → conflict; release → claim kedua ok; file berbeda → ok", () => {
    const map = new OwnershipMap();
    expect(map.claimFiles("t1", ["lib/math.py"])).toEqual({ status: "ok" });

    // file SAMA dengan klaim aktif t1 → conflict + daftar pemilik
    const c2 = map.claimFiles("t2", ["lib/math.py"]);
    expect(c2).toEqual({ status: "conflict", conflictsWith: ["t1"] });
    // klaim pemilik TIDAK di-overwrite
    expect(map.claimOf("t1")!.files).toEqual(["lib/math.py"]);
    // t2 tercatat sebagai intent (pending), bukan pemilik
    expect(map.claimOf("t2")).toBeNull();
    expect(map.allClaims()["t2"]!.status).toBe("pending");

    // release → re-claim t2 berhasil
    map.release("t1");
    expect(map.claimFiles("t2", ["lib/math.py"])).toEqual({ status: "ok" });
    expect(map.claimOf("t2")!.files).toEqual(["lib/math.py"]);

    // file berbeda → ok (tanpa konflik)
    expect(map.claimFiles("t3", ["lib/greet.py"])).toEqual({ status: "ok" });
  });

  it("conflictsWith: hanya owner AKTIF yang overlap (filter isActive)", () => {
    const running = new Set(["t1"]);
    const map = new OwnershipMap({ isActive: (id) => running.has(id) });
    map.claimFiles("t1", ["lib/math.py"]);
    map.claimFiles("t2", ["lib/greet.py"]);

    expect(map.conflictsWith("t3")).toEqual([]); // belum klaim
    map.claimFiles("t3", ["lib/math.py"]); // pending (bentrok t1)
    expect(map.conflictsWith("t3")).toEqual(["t1"]); // t1 aktif + overlap
    running.delete("t1");
    expect(map.conflictsWith("t3")).toEqual([]); // owner tidak aktif → tidak men-defer

    // overlap multi-file, sorted deterministik
    running.add("t2");
    map.claimFiles("t4", ["lib/greet.py", "lib/extra.py"]);
    expect(map.conflictsWith("t4")).toEqual(["t2"]);
    expect(map.overlapFiles("t4", "t2")).toEqual(["lib/greet.py"]);
  });

  it("normalisasi path: ./lib/math.py == lib/math.py (deteksi tidak lolos karena format)", () => {
    const map = new OwnershipMap();
    map.claimFiles("t1", ["./lib/math.py"]);
    expect(map.claimFiles("t2", ["lib/math.py"])).toEqual({ status: "conflict", conflictsWith: ["t1"] });
  });

  it("alert & metric: line log `conflict-detected a b files=[...]` + counter idempoten per pair", () => {
    const alerts: string[] = [];
    const map = new OwnershipMap({ onConflict: (a, b) => alerts.push(`${a}|${b}`) });
    map.claimFiles("tA", ["lib/x.py", "lib/y.py"]);
    map.claimFiles("tB", ["lib/x.py"]);

    expect(map.conflictCount()).toBe(1);
    expect(map.conflictLog()).toEqual(["conflict-detected tB tA files=[lib/x.py]"]);
    expect(alerts).toEqual(["tB|tA"]);

    // deteksi ulang pair yang sama → TIDAK menambah counter (idempoten)
    map.noteConflict("tB", "tA");
    map.noteConflict("tA", "tB");
    expect(map.conflictCount()).toBe(1);
    expect(map.conflictLog()).toHaveLength(1);

    // pair berbeda → counter naik
    map.claimFiles("tC", ["lib/y.py"]);
    expect(map.conflictCount()).toBe(2);
  });

  it("persistence: state (klaim pending + counter + log) selamat lewat reload file", () => {
    const file = join(tmp(), "ownership.json");
    const m1 = new OwnershipMap({ filePath: file });
    m1.claimFiles("t1", ["lib/math.py"]);
    m1.claimFiles("t2", ["lib/math.py"]);

    const m2 = new OwnershipMap({ filePath: file });
    expect(m2.claimOf("t1")!.files).toEqual(["lib/math.py"]);
    expect(m2.allClaims()["t2"]!.status).toBe("pending");
    expect(m2.conflictCount()).toBe(1);
    expect(m2.conflictLog()[0]).toContain("conflict-detected");

    // release di instance kedua terlihat tanpa reload ulang
    m2.release("t1");
    const m3 = new OwnershipMap({ filePath: file });
    expect(m3.claimFiles("t2", ["lib/math.py"])).toEqual({ status: "ok" });
    // file JSON berisi counter & klaim
    const raw = JSON.parse(readFileSync(file, "utf8")) as { counters: { conflict_detected: number } };
    expect(raw.counters.conflict_detected).toBe(1);
  });
});
