/**
 * resource_map.ts — Resource and Dependency-Aware Concurrency Control (Fase 6).
 *
 * Mendeteksi konflik bukan hanya berbasis file path, tetapi juga resource umum
 * seperti database schema, lockfiles (package-lock), environment variables,
 * atau port servis.
 */

export interface ResourceClaim {
  taskId: string;
  resources: string[]; // e.g. ["db:schema", "pkg:lock", "port:8082"]
  dependencies: string[]; // task_id yang harus selesai sebelum task ini boleh run
  mode: "exclusive" | "read_only";
}

export class ResourceConflictMap {
  private claims: Map<string, ResourceClaim> = new Map();
  private completedTasks: Set<string> = new Set();

  public registerCompleted(taskId: string): void {
    this.completedTasks.add(taskId);
    this.claims.delete(taskId);
  }

  public canAdmit(claim: ResourceClaim): { admitted: boolean; reason?: string } {
    // 1. Cek dependencies
    for (const depId of claim.dependencies) {
      if (!this.completedTasks.has(depId)) {
        return {
          admitted: false,
          reason: `Dependency task ${depId} belum selesai`,
        };
      }
    }

    // 2. Cek resource collision
    for (const [activeId, activeClaim] of this.claims.entries()) {
      if (activeId === claim.taskId) continue;

      const shared = claim.resources.filter((r) => activeClaim.resources.includes(r));
      if (shared.length > 0) {
        // Jika salah satu butuh exclusive mutasi -> tolak
        if (claim.mode === "exclusive" || activeClaim.mode === "exclusive") {
          return {
            admitted: false,
            reason: `Resource conflict on: ${shared.join(", ")} dengan active task ${activeId}`,
          };
        }
      }
    }

    return { admitted: true };
  }

  public claim(claim: ResourceClaim): void {
    this.claims.set(claim.taskId, claim);
  }

  public release(taskId: string): void {
    this.claims.delete(taskId);
  }
}
