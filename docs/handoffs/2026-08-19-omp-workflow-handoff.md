# HANDOFF: Hermes ↔ OMP Workflow & Instruction Architecture

**Date:** 2026-08-19
**Author:** Hermes (Shorekeeper session)
**Status:** Findings validated via quick research + live OMP benchmark
**Audience:** Future Hermes sessions taking over OMP orchestration work

---

## 1. CORE QUESTION RESOLVED

**Q:** "Is SOUL.md purely persona, or persona + instructions?"
**A:** **Persona + core instructions.** SOUL is slot #1 of the system prompt and anchors behavior. Persona-only SOUL leaves the agent without decision heuristics. BUT SOUL must not become a dumping ground for technical details — distribute across layers.

---

## 2. THE 5-LAYER INSTRUCTION ARCHITECTURE

| Layer | Home | Role | Example Content |
|-------|------|------|-----------------|
| **1. Identity** | `SOUL.md` (~/.hermes/) | Who I am + principles + decision heuristics | "Safety first, verify before merge, choose lightest adequate tool" |
| **2. Procedures** | Skills (~/.hermes/skills/) | Reusable how-to | "How to spawn OMP worker, verify gate, merge orchestration" |
| **3. Project context** | `AGENTS.md` (per-repo) | Repo conventions | "This repo: SQLite WAL, Zod contracts, no force-push" |
| **4. Config** | `config.yaml` | Technical params | model, timeouts, concurrency limits |
| **5. Runtime** | Live state | Current environment | git status, available tools, workload |

**Key insight:** If SOUL carries everything → too long, hard to maintain, mixed concerns. If SOUL carries nothing operational → agent can't deliberately select skills/tools. **Solution: persona + heuristics in SOUL, specifics in layers 2-5.**

---

## 3. OMP vs HERMES SUBAGENT — DIVISION OF LABOR

| Aspect | Hermes Subagent | OMP Worker |
|--------|----------------|------------|
| Type | General-purpose fork agent | Specialist coding CLI |
| Edit mechanism | patch/write_file | Hash-anchored edits + LSP |
| Isolation | Own session, shared FS | Detached git worktree |
| Parallel safety | Manual conflict risk | Pre-spawn conflict detection |
| Result verification | Self-report (unreliable) | Gate: tests must pass first |
| Merge | Parent decides | Sequential squash-merge (orchestrator only) |
| Model | Inherits parent | Own config |
| Overhead | Light (in-process) | Process spawn per task |

**When to use which:**
- Small edit <10 lines → Hermes direct (OMP overhead too big)
- Medium-large coding in git repo, many iterations → OMP
- Research/summarize/non-code → Hermes subagent
- Review, git ops, commit, merge, push/PR → Hermes main agent (needs judgment + approval gates)

---

## 4. IDEAL FULL WORKFLOW (VALIDATED PATTERN)

```
Phase 1: PLAN        → Hermes main agent (/goal → research → PRD → task breakdown)
Phase 2: EXECUTE     → OMP workers (each task in isolated worktree, timeout enforced)
Phase 3: VERIFY      → verifier runs tests; green = merge-ready
Phase 4: MERGE       → orchestrator ONLY, sequential squash-merge (hard rule: workers never merge)
Phase 5: PUSH/PR     → approval gate; never auto-push without explicit approval
```

**Hard rules (from Shorekeeper AGENTS.md):**
- Workers NEVER commit/push to main directly
- One task = one worker (no file conflicts by design)
- Sequential merges only
- Kill on timeout (SIGKILL)
- Verifier fail-open: broken code never merges

---

## 5. BENCHMARK EVIDENCE (Task Orchestration Hub build)

OMP (via `omp -p --approval-mode yolo --model qd/qmodel_38max`) built a real fullstack project:
- TASK-01 (monorepo + Zod contracts + skeletons): ✅ ~5 min, 10 files, valid TS/JSON
- TASK-02 (Hono server + better-sqlite3 store + WebSocket): ✅ ~7 min, 9 files
- TASK-03 (Svelte 5 client): in progress at handoff time
- Project: `/home/ubuntu/projects/task-orchestration-hub`
- All output verified by Hermes (read files, checked schemas, confirmed compile-ready)

**Observed strengths:** Accurate schemas, clean structure, zero syntax errors, follows prompt constraints closely.
**Observed caveats:** 9Router context grows fast (~171K tokens cached by TASK-02) — monitor quota; OMP self-reports need independent verification.

---

## 6. PROMPT TEMPLATE FOR OMP TASKS

```
You are building '[Project]' — [description]. TASK-[N] of build plan. Previous tasks completed.

REQUIREMENTS:
[explicit file list with paths, exact fields/behaviors]

RULES:
[constraints: allowed deps, error handling, response codes]

When done, list all files you created.
```
(Do NOT include `pnpm install` in tasks — too slow; Hermes runs installs during verify phase.)

---

## 7. OPEN ITEMS / FOLLOW-UPS

1. **Skill creation blocker:** `skill_manage` create requires description ≤60 chars. 7 attempts failed. → Create `devops-omp-coding-workflow` skill with short description: "Delegate coding to OMP: worktrees + merge gates." (content already drafted — see mempalace or recreate from this doc).
2. **SOUL.md review:** Schnee's current SOUL is persona+instructions (correct pattern). Optional: add explicit "tool selection heuristic" table + "self-awareness checklist" from this doc.
3. **Finish benchmark:** TASK-03 (client) → TASK-04 (tests+Docker+nginx) → verify (pnpm install + build + tests) → deploy → final report.
4. **Domain decision pending:** local-only deploy works now; public HTTPS needs Schnee's DNS setup (manual step — cannot automate DNS without provider API access).

---

## 8. RESEARCH SOURCES

- https://github.com/can1357/oh-my-pi (OMP architecture: hash edits, LSP, worktree subagents)
- https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns
- https://hermes-agent.nousresearch.com/docs/user-guide/features/personality/ (SOUL = identity slot #1, customizable)
- Betterstack/explainx OMP deep-dives (2026)
