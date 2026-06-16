# Spec: phantom RSC Readiness & Migration Map

Status: approved design (2026-06-16). Implementation pending in a fresh session.

## Summary

A new `phantom rsc <dir>` analysis command that reads an existing React codebase and produces a **whole-codebase RSC migration map**:

- a per-component **server-eligible vs must-be-client** verdict (with the reason),
- the **minimal `'use client'` boundary set** to add,
- the client **blast radius** propagated along the import graph,
- an honest **realizable-server estimate** (files + bytes) with graph-resolution coverage,
- **rescue opportunities** (static subtrees trapped under a client parent by import that could stay server via a `children` slot),
- obvious **serialization hazards** (non-serializable props crossing a boundary).

Report-first, drop-in, read-only. The **analysis core is framework-agnostic**; a thin **Next-first output/advice adapter** sits on top, with the adapter boundary kept clean so React Router RSC / Vite RSC can be added later.

## Why (context for a cold reader)

phantom is an unplugin-based React build plugin (`phantom-build`) that does automatic `React.lazy`/Suspense wrapping, event-handler extraction, and SSR-boundary classification (`FullyStatic`/`SSRSafe`/`ClientOnly`). A long investigation (see memory `phantom-evolution-ceiling`) established:

- phantom's **code-splitting mechanism is near its value ceiling**: on real apps the eliminable/static slice is small (~8–22% of app bytes), the dominant bytes are the vendor shell (largely irreducible without going server-side), and "high-static" apps are already framework-handled (Next/RSC, Sitecore SSR).
- The **per-file `'use client'` verdict is a commodity**: at least three eslint plugins do it (roginfarrer/eslint-plugin-react-server-components, @naverpay/eslint-plugin-use-client, @eslint-react), all per-file/lint-only, and Vercel is being pushed to ship an official rule. **We do not rebuild that.**
- The **unserved gap is graph-level migration intelligence**: nobody propagates client-ness across imports, computes a minimal boundary frontier, or produces a migration map. eslint is per-file by design and structurally can't. The closest project tool (nextjs-analyzer) is per-file detection only.
- A throwaway prototype (`/tmp/phantom-bisect/measure-rsc.mjs`, may no longer exist) confirmed the blast radius is **computable** from phantom's existing classifier + import graph, and that the realizable-server fraction is **small on real apps** — so the product sells the **map and safety**, not a big server-component win.

**Accuracy is the moat.** A wrong `server-eligible` verdict breaks someone's migration, so correctness is treated as P0. This also leverages the soundness discipline already applied to phantom's lazy classifier.

## Goals

1. Produce a correct, whole-codebase RSC migration map for an existing React app.
2. Cross-module analysis: propagate client-ness along import edges; compute the realizable-server set and the minimal `'use client'` frontier.
3. Honest realizable-server estimate (files + bytes), always reported **with** import-edge resolution coverage so the number is interpretable.
4. Surface rescue opportunities (children-slot refactors) and obvious serialization hazards.
5. Human (terminal + markdown) and machine (JSON) output.
6. Framework-agnostic analysis; Next-first advice adapter behind a clean interface.

## Non-goals (v1)

- No codemod / auto-insert of `'use client'` (phase 2).
- No deep serialization / type-flow analysis (shallow heuristic only in v1).
- No non-Next advice adapters in v1 (keep the interface, don't implement others yet).
- No runtime, no build transform, no LLM.
- Not another per-file eslint rule — that's the commodity layer we sit on top of.

## Success criteria

- Runs on the real corpora (the PMI Sitecore apps, the wonderful/ Medusa apps, and reference apps shadcn/bulletproof/memos) with **>90% import-edge resolution** (the prototype hit 23–71% because it ignored path aliases + barrels — fixing that is the core engineering).
- Produces a **correct** migration map on fixture codebases with hand-verified graphs (contagion + frontier correctness, asserted by tests).
- A wrong `server-eligible` verdict is a P0 bug. Prefer false "must-be-client" (conservative) over false "server-eligible" (unsafe), mirroring the lazy guard's conservative bias.

## Architecture (isolated, independently testable units)

1. **Graph resolver** — NEW, highest-risk. Resolve every relative + aliased + barrel import to a concrete file.
   - Inputs: a file, its import specifiers (from `parseModule`'s `ImportInfo`), the project's `tsconfig.json` (`baseUrl` + `paths`), the set of project files.
   - Output: resolved absolute file paths per import edge; a resolution-coverage stat.
   - Must handle: relative (`./`, `../`), tsconfig path aliases (`@/...`, `~/...`), and barrels (`index.ts(x)` re-exports, at least one hop; transitive is a stretch goal).
   - Pure and heavily tested. Trust rides on this unit.

2. **RSC classifier** — thin reuse of `src/classify/ssr-boundary.ts`.
   - Maps `FullyStatic` → `server-eligible`; `SSRSafe` (hooks/state/effects) and `ClientOnly` (browser APIs/handlers) → `must-be-client`, carrying the human-readable reason (which hook/handler/API forces it).
   - Note the subtlety: phantom's `SSRSafe` means "safe to SSR for first paint," which is **broader** than "can be a Server Component." A component using `useState` is `SSRSafe` but is **must-be-client** for RSC. The mapping above encodes that.

3. **Contagion + frontier engine** — NEW, pure graph algorithms.
   - Seed = files containing any `must-be-client` component (or top-level browser access).
   - Propagate client-ness **forward along import edges** (importer → imported): a client file's imported components become client.
   - Compute: client closure, realizable-server set (`server-eligible` ∧ not in closure), and the **minimal `'use client'` frontier** (topmost client node per subtree — the smallest set of directives that is correct).

4. **Rescue / hazard detector** — NEW, shallow in v1.
   - Rescue: a `server-eligible` component pulled into the client closure **only** because a client component imports it directly — flag as a `children`-slot refactor candidate (server content passed as `children` is not an import, so it stays server).
   - Hazard: a client component receiving an obviously non-serializable prop (function, class instance, JSX element) from a would-be server parent. Shallow heuristic in v1.

5. **Report emitter** — NEW.
   - Human: terminal summary + a markdown report. Machine: JSON (stable schema for CI / tooling).

**Reused as-is:** `parseModule` (analyzer), `classifyModuleWithContext` + `classifyModuleSSR` (classifier), the `ImportInfo` extraction. **New:** units 1, 3, 4, 5 and the RSC mapping in 2.

## Data flow

```
files (glob *.tsx/*.ts) 
  → parse + SSR-classify each            (reuse)
  → per-file RSC verdict + reasons        (unit 2)
  → resolve import edges → component graph (unit 1)
  → propagate contagion → closure, realizable-server, minimal frontier (unit 3)
  → rescue + hazard detection             (unit 4)
  → emit human + JSON report              (unit 5)
```

## RSC semantics the engine must encode (correctness-critical)

- Server Component: no hooks/state/effects/event-handlers/browser APIs; ships zero client JS; never hydrates.
- `'use client'` is a file-level directive; the file **and its transitive imports** are client.
- Contagion flows importer → imported. One client importer forces an imported component client.
- `children` escape hatch: server content passed as `children`/slots to a client component stays server (it is not an import of the client module) → the basis for rescue suggestions.
- Props crossing a server → client boundary must be serializable → hazard if function/class/JSX-as-prop.
- Multi-component files: `'use client'` is all-or-nothing per file; a file mixing a server-eligible and a must-be-client component should be flagged as a **split candidate**.

## Output (the product)

Human:
```
312 components · import graph 96% resolved
Server-eligible: 142 · Realizable after blast radius: 58 (84 trapped by contagion)
'use client' frontier: 41 files to mark   [minimal set, listed]
Top rescues: ProductGrid trapped under <Cart> by import → pass as children to keep server
Blockers: 9 non-serializable props cross a boundary   [file:line]
```

JSON: stable schema with per-component verdict+reason, edges, closure, frontier, realizable stats (files+bytes+coverage), rescues, hazards.

## Testing

- TDD throughout; conservative bias (false must-be-client over false server-eligible).
- Fixture codebases with hand-known graphs assert contagion + frontier correctness.
- The graph resolver gets the heaviest coverage (aliases, barrels, monorepo tsconfig).
- The real corpora (PMI / wonderful / reference apps) are integration targets; assert >90% edge resolution and no crashes.

## Risks / constraints carried in

- **Accuracy is the moat** (wrong verdict breaks a migration).
- **Vercel could move into this space** — framework-agnostic + graph-depth is the defensible ground, not the per-file verdict.
- **Market is Next-centric and migration-phase** (time-windowed). Framework-agnostic core hedges this.
- **Realizable-server is small** on real apps — the product is the map + safety, not a transformation.

## Open questions (resolve during implementation)

- tsconfig resolution: read `compilerOptions.baseUrl` + `paths`; handle monorepos with multiple/nested tsconfigs and `extends`.
- Barrel resolution depth: one hop is the floor; decide if transitive re-export following is worth it for coverage.
- How to weight "realizable-server" — file count vs source bytes vs estimated minified bytes (report all three; bytes is the honest headline).
- CLI surface: `phantom rsc <dir> [--json] [--markdown out.md]`; reuse the existing CLI entry (`src/cli.ts`).
