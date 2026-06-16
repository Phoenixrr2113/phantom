# RSC Readiness & Migration Map — Tasks

Tick each as it completes. See `plan.md` for the implementation detail per task
and `spec.md` for the design rationale. Each task is TDD (failing test → minimal
impl → green → commit). Conservative bias: when unsure, classify must-be-client.

## Phase 0 — Scaffolding
- [ ] Task 0: Branch `feat/rsc-readiness`, add `get-tsconfig`, write `src/rsc/types.ts`

## Phase 1 — RSC classifier (reuse)
- [ ] Task 1: `classifyFileRsc` — SSR classification → per-file RSC verdict (server-eligible / must-be-client / mixed / non-component) + reasons

## Phase 2 — Graph resolver (highest risk)
- [ ] Task 2: `resolveImport` for relative imports (extensions + index)
- [ ] Task 3: tsconfig path-alias resolution (`@/*`) via `get-tsconfig`
- [ ] Task 4: one-hop barrel (`index.ts` re-export) resolution
- [ ] Task 5: `buildComponentGraph(dir)` with `edgeResolution` coverage metric

## Phase 3 — Contagion + frontier (pure)
- [ ] Task 6: `computeContagion` — propagate client-ness importer→imported; client closure + realizable-server
- [ ] Task 7: `computeFrontier` — minimal `'use client'` set (topmost client nodes)

## Phase 4 — Rescue + hazards (shallow v1)
- [ ] Task 8: `findRescues` — children-slot rescue candidates
- [ ] Task 9: `findHazards` — shallow non-serializable prop detection across boundaries

## Phase 5 — Report + CLI
- [ ] Task 10: `analyzeRscReadiness` orchestrator + `report.ts` (toJSON/toMarkdown/toTerminal)
- [ ] Task 11: `phantom rsc <dir> [--json] [--markdown <out>]` CLI subcommand

## Phase 6 — Integration + docs
- [ ] Task 12: real-corpus integration test + ≥90% edge-resolution gate (skip if corpus absent)
- [ ] Task 13: README + ARCHITECTURE docs for the RSC pass
