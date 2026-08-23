# Shorekeeper

Voice-first multi-agent AI assistant.

## Dokumentasi

- [PRD](docs/PRD.md) — Product Requirements Document
- [ARCHITECTURE](docs/ARCHITECTURE.md) — System design & C4 diagrams
- [TASKS](TASKS.md) — Implementation tasks (13 tasks, 3 phases)
- [AGENTS](docs/agents/) — Persona prompts (SOUL.md, VOICE_MODE.md, FRONT_AGENT.md)

## Goal untuk /goal

Lihat `goal-all-phases.txt` untuk prompt lengkap.

## Struktur

```
apps/
  agent/          # LiveKit agent (front)
  orchestrator/   # Hermes integration
  token-server/   # LiveKit JWT
  client/         # Svelte UI
packages/
  contracts/      # JSON Schema + codegen
  omp-bridge/     # oh-my-pi integration
  task-store/     # SQLite WAL
scripts/
  gates/          # Quality gates per phase
  e2e/            # E2E test harness
  eval/           # Golden test suite
  ops/            # Backup, restore, deploy
tests/
  unit/ integration/ e2e/
```
