#!/usr/bin/env node
/**
 * mock-worker-cli — entry point spawn-able untuk mock worker (dist/mock-worker-cli.js).
 * Dipanggil bridge saat OMP_BRIDGE_MOCK=1 (lihat src/index.ts runTask).
 */
import { runMockWorker } from "./mock-worker.js";

process.exit(await runMockWorker(process.argv.slice(2)));