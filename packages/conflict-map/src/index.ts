/**
 * conflict-map — deteksi konflik file antar worker SEBELUM merge (TASK-2.1/2.3).
 *
 * - merge-tree.ts: pre-merge check via `git merge-tree --name-only` + irisan diff
 *   (false-positive-leaning). Dipakai merge orchestrator (TASK-2.1) sebagai
 *   defense-in-depth sebelum squash merge sequential.
 * - ownership.ts (TASK-2.3): file ownership map one-file-one-owner + claim/release,
 *   pre-spawn check di worker manager (`data/ownership.json`).
 */
export * from "./merge-tree.js";
export * from "./ownership.js";