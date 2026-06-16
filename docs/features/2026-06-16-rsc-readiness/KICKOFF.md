# Kickoff prompt — RSC Readiness & Migration Map

Paste the block below into a fresh Claude Code session opened in the phantom-build repo
(`~/Desktop/projects/started-building/phantom`).

---

Implement the **RSC Readiness & Migration Map** feature in this repo (`phantom-build`).

**Read first, in order:**
1. `docs/features/2026-06-16-rsc-readiness/spec.md` — what, why, and the design.
2. `docs/features/2026-06-16-rsc-readiness/plan.md` — the phased, TDD implementation plan (has real test code + implementation per task).
3. `docs/features/2026-06-16-rsc-readiness/tasks.md` — the flat checklist.

(The project memory note `phantom-evolution-ceiling` is auto-loaded and has the full strategic backstory — skim it for context on *why* this is the chosen direction.)

**What you're building (one line):** a `phantom rsc <dir>` command that produces a whole-codebase React Server Components migration map — per-file server-eligible vs must-be-client verdict, the minimal `'use client'` frontier, the client blast radius along the import graph, an honest realizable-server estimate, plus children-rescue and serialization-hazard hints. Report-only, read-only, framework-agnostic analysis core.

**Non-negotiable constraints:**
- **Accuracy is the moat.** Conservative bias: when unsure, classify **must-be-client** (safe). Never over-report **server-eligible** (unsafe) — treat that as a P0 bug.
- **Reuse phantom's engine**, don't reinvent: `parseModule` (`src/analyzer.ts`), `classifyModuleWithContext` + `classifyModuleSSR` (`src/classify/index.ts`). Remember `SSRSafe` ≠ server-eligible (a `useState` component is `SSRSafe` but must be client). Mapping: `FullyStatic` → server-eligible; `SSRSafe`/`ClientOnly` → must-be-client.
- **The import-graph resolver is make-or-break.** It must handle relative imports, tsconfig path aliases (`@/…`, via the `get-tsconfig` dep), and one-hop barrels. The gate is **≥90% edge resolution** on a real corpus (`benchmarks/shadcn-admin/src`). Low resolution silently over-reports server-eligibility.
- **v1 = analysis + report only.** No codemod, no deep serialization analysis, no non-Next adapters, no runtime, no build-transform changes. Don't build another per-file eslint rule — that's commodity; sit on top of it with the graph layer.

**How to execute:**
- Use the **superpowers:subagent-driven-development** skill (preferred) or **superpowers:executing-plans** to work `plan.md` task-by-task.
- Every task is strict TDD: write the failing test → run it and watch it fail → minimal implementation → watch it pass → commit. The plan already contains the test cases and code.
- Branch first (`feat/rsc-readiness`); Task 0 covers branching + adding `get-tsconfig`.
- Before declaring any phase done, run `npx tsc --noEmit && npx vitest run` and confirm clean.

**Before writing code:** verify the plan still matches the codebase (exact exported names like `classifyModuleSSR`, `classifyModuleWithContext`, `parseModule`, the `SSRComponentResult.classification` union, the CLI shape in `src/cli.ts`). If anything has drifted, flag it and adjust the plan before proceeding.

Start with Phase 0, Task 0.

---
