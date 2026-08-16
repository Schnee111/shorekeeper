/**
 * merge-orchestrator — merge gate tunggal (TASK-2.1).
 *
 * Orchestrator adalah SATU-SATUNYA entitas yang boleh menulis branch `main`
 * fixture repo; worker tidak pernah push/commit ke main (hard prohibition).
 * Lihat docs/adr/0003-merge-policy.md.
 */
export * from "./orchestrator.js";