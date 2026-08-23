/**
 * lint-golden.mjs — schema check golden set (TASK-3.3).
 * Exit 0 bila semua valid; exit 1 + daftar file bermasalah bila tidak.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DIR = join(ROOT, "docs", "golden-set");

const CATEGORIES = ["routing_handoff", "single_task", "multi_agent", "edge_case", "safety"];
const EXPECTED_DIST = { routing_handoff: 5, single_task: 5, multi_agent: 3, edge_case: 4, safety: 3 };
const RUBRIC_KEYS = ["correctness", "tool_use", "safety", "voice_format"];

const files = readdirSync(DIR).filter((f) => /^gs-.*\.yaml$/.test(f)).sort();
const problems = [];
const seenIds = new Set();
const dist = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));

for (const f of files) {
  const path = join(DIR, f);
  const rel = `docs/golden-set/${f}`;
  let doc;
  try {
    doc = yaml.load(readFileSync(path, "utf8"));
  } catch (err) {
    problems.push(`${rel}: YAML invalid — ${err.message.split("\n")[0]}`);
    continue;
  }
  if (!doc || typeof doc !== "object") {
    problems.push(`${rel}: dokumen kosong / bukan mapping`);
    continue;
  }
  const req = ["id", "task", "category", "input", "harness", "expected_outcome", "rubric", "autonomy_expected", "tags"];
  for (const k of req) {
    if (doc[k] === undefined || doc[k] === null || doc[k] === "") {
      problems.push(`${rel}: field wajib "${k}" kosong`);
    }
  }
  if (doc.id && doc.id !== f.replace(/\.yaml$/, "")) {
    problems.push(`${rel}: id "${doc.id}" != nama file "${f.replace(/\.yaml$/, "")}"`);
  }
  if (doc.id && seenIds.has(doc.id)) problems.push(`${rel}: id duplikat "${doc.id}"`);
  if (doc.id) seenIds.add(doc.id);
  if (doc.category && !CATEGORIES.includes(doc.category)) {
    problems.push(`${rel}: category "${doc.category}" tidak dikenal (${CATEGORIES.join(",")})`);
  } else if (doc.category) {
    dist[doc.category] += 1;
  }
  if (doc.rubric) {
    for (const rk of RUBRIC_KEYS) {
      const v = doc.rubric[rk];
      if (typeof v !== "string" || v.trim().length < 10) {
        problems.push(`${rel}: rubric.${rk} wajib terisi (teks rubrik eksplisit, ≥10 char)`);
      }
    }
    if (doc.category === "safety" && !/critical|wajib|ditolak|tidak boleh|deny/i.test(doc.rubric.safety ?? "")) {
      problems.push(`${rel}: rubric.safety kasus safety wajib menyatakan kriteria penolakan eksplisit`);
    }
  }
  if (doc.expected_outcome && typeof doc.expected_outcome !== "object") {
    problems.push(`${rel}: expected_outcome wajib mapping (checks terstruktur)`);
  }
  if (doc.harness && typeof doc.harness !== "object") {
    problems.push(`${rel}: harness wajib mapping (action + parameter)`);
  }
  if (!Array.isArray(doc.tags) || doc.tags.length === 0) {
    problems.push(`${rel}: tags wajib list non-kosong`);
  }
}

if (files.length !== 20) problems.push(`jumlah kasus ${files.length} != 20`);
for (const c of CATEGORIES) {
  if (dist[c] !== EXPECTED_DIST[c]) {
    problems.push(`distribusi kategori ${c}: ${dist[c]} != ${EXPECTED_DIST[c]}`);
  }
}

if (problems.length > 0) {
  console.error(`[lint-golden] GAGAL — ${problems.length} masalah:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[lint-golden] OK — 20 kasus valid, rubric lengkap, distribusi ${JSON.stringify(dist)}`);
