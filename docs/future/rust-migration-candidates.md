# Rust Migration Candidates

This document catalogs which parts of Phantom's build pipeline are candidates for replacement with a Rust-based NAPI addon, what OXC crates provide, and the expected benefits. The goal is to eventually replace the JS-based analysis with OXC's `oxc_semantic` + `oxc_cfg` exposed through `napi-rs`.

## Current Architecture (JS)

```
Source Code
  → oxc-parser (Rust, via npm)     ← Already Rust
  → ast-compat.ts (JS)             ← ESTree metadata patching
  → eslint-scope (JS)              ← Scope analysis
  → classify/ pipeline (JS)        ← Taint + purity + boundary + SSR
  → extract/ pipeline (JS)         ← Code generation + AST mutation
  → esrap (JS)                     ← Code generation
```

## Target Architecture (Rust NAPI Addon)

```
Source Code
  → oxc_parser (Rust)              ← Parsing
  → oxc_semantic (Rust)            ← Scope + symbols + references + CFG
  → phantom-native (Rust)          ← Custom analysis (taint, SSR, render path)
  → napi-rs                        ← Bridge to Node.js
  → extract/ pipeline (JS)         ← Keep in JS (needs AST mutation + codegen)
```

---

## Tier 1: High-Impact Replacements

These modules would benefit most from Rust replacement. They fight against JS tooling limitations and would gain both correctness and performance.

### 1. Scope Analysis (replace `eslint-scope`)

**Current**: `eslint-scope` v8 — runs in JS, builds scope tree, resolves references.

**Problems in JS**:
- "Through" references bubble up globals from ALL nested scopes into the parent. This forced us to build render path globals bottom-up with `collectGlobalsOnlyInExcluded()` — a workaround for eslint-scope's scope flattening.
- No per-reference position info easily accessible — we use AST walking + position checks to determine if a global reference is inside a guarded block.
- No way to query "which scope does this specific reference belong to?"

**Rust replacement**: `oxc_semantic::Scoping`
- `Scoping::symbol_references(SymbolId)` — all references to a specific symbol
- `Reference::scope_id()` — which scope a reference lives in
- `ScopeTree::ancestors(ScopeId)` — walk up the scope chain
- `SemanticBuilder::new().build(&program)` — one pass, gives everything
- Each reference has position info, so no AST re-walking needed

**Impact**: Eliminates the biggest source of complexity in SSR boundary detection. The entire `collectGlobalsOnlyInExcluded()`, `collectGuardedGlobals()`, `countGlobalUsages()`, `countTypeofUsages()` machinery (~100 lines) becomes unnecessary.

**Files affected**: `src/analyzer.ts` (buildFunctionDependencies), `src/classify/ssr-boundary.ts`

### 2. Control Flow Graph (replace mini-CFG)

**Current**: Hand-written `detectEarlyReturnGuards()` — a targeted mini-CFG that walks function bodies looking for `if (typeof window === 'undefined') return` patterns.

**Problems in JS**:
- Only handles the simplest early return pattern (one if-without-else at top level)
- Cannot detect: nested early returns, throw-based guards, switch-case fallthrough, ternary with side effects
- No general reachability analysis — we can't answer "is statement X reachable on the server?"
- Building a full CFG in JS would be ~500-1000 lines with significant perf cost

**Rust replacement**: `oxc_cfg::ControlFlowGraph`
- `BasicBlock::is_unreachable()` — is this block dead code?
- `ControlFlowGraph::is_reachable(from_block, to_block)` — reachability query
- `SemanticBuilder::new().with_cfg(true).build(&program)` — builds CFG alongside scope analysis in one pass
- Per-instruction tracking within basic blocks

**Impact**: Would correctly handle ALL guard patterns — early returns, throws, conditional assignments, nested guards. The entire `detectEarlyReturnGuards()` + `detectEarlyReturnInBlock()` + `blockContainsReturn()` machinery (~70 lines) becomes a simple reachability query. More importantly, unlocks new patterns we currently can't detect at all.

**Files affected**: `src/classify/ssr-boundary.ts`

### 3. AST Compatibility Layer (eliminate `ast-compat.ts`)

**Current**: `addASTMetadata()` — post-processes OXC's AST to add ESTree `range` and `loc` properties that eslint-scope requires.

**Problems in JS**:
- Walks the entire AST tree just to add metadata that eslint-scope needs
- Builds a line-start table and does binary search for every node's line/column
- Pure overhead — the positions are already known in OXC's Rust representation

**Rust replacement**: Not needed. If scope analysis moves to Rust, eslint-scope is removed, and the ESTree patching is unnecessary. OXC's `Span` already has byte offsets, and `oxc_semantic` works directly with them.

**Impact**: Eliminates ~99 lines and a full AST traversal. Parsing becomes a single Rust call with no JS post-processing.

**Files affected**: `src/ast-compat.ts` (delete entirely), `src/analyzer.ts` (remove addASTMetadata call)

---

## Tier 2: Moderate-Impact Replacements

These modules would benefit from Rust but could also stay in JS without major correctness issues.

### 4. Taint Analysis (could move to Rust)

**Current**: `src/classify/taint.ts` — classifies function globals as browser/ambiguous/pure/unknown, propagates taint through call chains.

**Why move**: Taint propagation walks the function dependency graph iteratively. In Rust, this is a simple graph traversal with the semantic data already available. The `BROWSER_GLOBALS`, `AMBIGUOUS_GLOBALS`, `PURE_GLOBALS` sets could be compiled into a perfect hash in Rust.

**Rust approach**: Use `oxc_semantic` reference data to build per-function global sets, then run a fixpoint taint propagation. Zero AST walking needed — all data comes from the symbol table.

**Impact**: ~86 lines moved to Rust. Not a huge correctness win, but removes dependency on eslint-scope's globals list.

**Files affected**: `src/classify/taint.ts`, `src/classify/browser-globals.ts`

### 5. Purity Analysis (could move to Rust)

**Current**: `src/classify/purity.ts` — determines if non-tainted functions are pure computation.

**Why move**: Once taint is in Rust, purity analysis is a trivial extension. Check for browser globals, ambiguous globals, and side-effect patterns. With CFG, we could even detect pure functions that have branches (currently we're conservative).

**Impact**: ~67 lines. Small module but benefits from being in the same Rust pass.

**Files affected**: `src/classify/purity.ts`

### 6. React Pattern Detection (could move to Rust)

**Current**: `src/classify/react-patterns.ts` + hook/event handler detection in `classify/index.ts`.

**Why move**: Hook context detection and event handler detection both walk the full AST. In Rust with `oxc_semantic`, this becomes:
- Hook detection: find CallExpression nodes where callee resolves to a known hook name
- Event handler detection: find JSXAttribute nodes with event prop names, resolve their values

With the Visit trait in Rust, both analyses are a single AST traversal combined with scope queries.

**Impact**: ~85 lines of pattern definitions + ~200 lines of detection logic in `classify/index.ts`.

**Files affected**: `src/classify/react-patterns.ts`, `src/classify/index.ts`

---

## Tier 3: Keep in JS

These modules should stay in JavaScript. They involve complex code generation, string manipulation, or integration logic that doesn't benefit from Rust.

### 7. Code Extraction (`src/extract/`)

**Why keep in JS**: The extraction pipeline mutates ASTs, generates new code modules, resolves imports, and produces source maps. This is inherently string/AST-generation work where JS is fine and the code needs to be flexible for frequent iteration.

- `extract/index.ts` — orchestration logic
- `extract/client-stub.ts` — generates lazy-loading stubs
- `extract/chunk-module.ts` — generates chunk module code
- `extract/import-resolver.ts` — import path resolution
- `extract/lazy-transform.ts` — React.lazy + Suspense wrapping

**Note**: `esrap` (JS codegen) stays as-is. If we ever need faster codegen, OXC has `oxc_codegen` in Rust, but it's not a bottleneck.

### 8. Plugin Integration (`src/plugin.ts`)

**Why keep in JS**: The unplugin integration, caching, manifest generation, and build lifecycle management is pure Node.js orchestration code. No reason to move this to Rust.

### 9. LLM Integration (`src/classify/llm-client.ts`, `src/classify/lazy-llm.ts`)

**Why keep in JS**: HTTP calls to the LLM API, JSON schema construction, and response merging. Pure application logic.

### 10. Lazy Component Detection (`src/classify/lazy.ts`)

**Why keep in JS for now**: At 840 lines, this is the largest classification module. It combines heuristics (below-fold detection, barrel file resolution, context provider detection) with data flow. The heuristics are heavily product-driven and change often. Moving to Rust would slow down iteration without a significant perf gain.

**Future**: If lazy detection needs CFG or precise scope info (e.g., detecting if a component prop is a function), some helper queries could be exposed from Rust. But the orchestration logic should stay in JS.

### 11. CLI (`src/cli.ts`)

**Why keep in JS**: Thin wrapper around the analysis pipeline. No reason to move.

### 12. Runtime (`src/runtime/index.ts`)

**Why keep in JS**: This is browser-side code that runs in production. It must be JavaScript. (82 lines, already minimal.)

---

## Migration Strategy

### Phase 1: Scope + CFG in Rust (Highest ROI)

Build a single Rust NAPI addon (`@phantom-build/native`) that exposes:

```typescript
interface PhantomNativeAnalysis {
  /** Per-function: globals, locals, captured, imported */
  functions: NativeFunctionInfo[];
  /** Per-function: which globals are in render path (excluding effects/handlers/guards) */
  renderPathGlobals: Map<string, string[]>;
  /** Per-function: is this a React component? (PascalCase + JSX) */
  components: string[];
  /** Per-function: SSR classification with CFG-based guard detection */
  ssrClassifications: Map<string, {
    classification: 'FullyStatic' | 'SSRSafe' | 'ClientOnly';
    confidence: number;
    reasons: string[];
    browserAPIs: string[];
    hooks: string[];
    hasGuards: boolean;
  }>;
  /** Top-level browser access */
  topLevelBrowserAPIs: string[];
}

/** Single Rust call replaces: parseModule + classifyModuleWithContext + classifyModuleSSR */
export function analyzeModule(code: string, path: string): PhantomNativeAnalysis;
```

**What this replaces**:
- `oxc-parser` npm package (now internal)
- `ast-compat.ts` (eliminated)
- `eslint-scope` (replaced by `oxc_semantic`)
- `classify/taint.ts` (moved to Rust)
- `classify/purity.ts` (moved to Rust)
- `classify/ssr-boundary.ts` (moved to Rust, with full CFG)
- `classify/browser-globals.ts` (compiled into Rust)
- Most of `classify/index.ts` (detection logic)
- `analyzer.ts` buildFunctionDependencies (replaced by Rust)

**What stays in JS**:
- `classify/boundary.ts` — classification rules (consumes Rust data)
- `classify/lazy.ts` — heuristic-heavy lazy detection
- `classify/react-patterns.ts` — hook/event lists (could move but low value)
- All of `extract/` — code generation
- `plugin.ts` — build integration
- `cli.ts`, `runtime/`, `vite.ts`, `webpack.ts`

### Phase 2: Lazy Detection Helpers

After Phase 1 proves out, expose additional Rust queries:
- `isBarrelFile(path)` — detect re-export-only modules
- `resolveComponentImports(code)` — find PascalCase imports from relative paths
- `estimateComponentCost(code)` — heuristic-based component complexity scoring

### Phase 3: Full Codegen (if needed)

If codegen becomes a bottleneck:
- Replace `esrap` with `oxc_codegen`
- Move AST mutation to Rust

---

## OXC Crate Versions & Stability

As of research (early 2025), all OXC crates are at ~0.114.0 (pre-1.0), with weekly releases.

**Required crates**:
```toml
[dependencies]
oxc_parser = "0.114"
oxc_semantic = "0.114"
oxc_cfg = "0.114"
oxc_ast = "0.114"
oxc_span = "0.114"
oxc_allocator = "0.114"
napi = { version = "2", features = ["napi9"] }
napi-derive = "2"
```

**Platform build matrix** (napi-rs standard):
- `x86_64-apple-darwin` (macOS Intel)
- `aarch64-apple-darwin` (macOS Apple Silicon)
- `x86_64-unknown-linux-gnu` (Linux x64)
- `aarch64-unknown-linux-gnu` (Linux ARM64)
- `x86_64-pc-windows-msvc` (Windows x64)

Published as optionalDependencies:
```json
{
  "@phantom-build/native-darwin-x64": "...",
  "@phantom-build/native-darwin-arm64": "...",
  "@phantom-build/native-linux-x64": "...",
  "@phantom-build/native-linux-arm64": "...",
  "@phantom-build/native-win32-x64": "..."
}
```

---

## Estimated Impact

| Metric | Current (JS) | After Rust (Phase 1) |
|--------|-------------|---------------------|
| Parse + Scope analysis | ~15ms/file | ~2ms/file (est. 7x faster) |
| SSR boundary detection | ~5ms/file | ~1ms/file (no re-walking) |
| Guard detection accuracy | 3 patterns | All patterns (CFG-based) |
| Lines of analysis code | ~2,500 | ~800 JS + ~1,200 Rust |
| Dependencies | oxc-parser + eslint-scope + esrap | @phantom-build/native + esrap |
| Correctness issues | typeof hack, scope bubbling, mini-CFG limits | None (proper scope + CFG) |

---

## Decision Criteria

Move to Rust when ANY of these are true:
1. **Guard detection is insufficient** — real-world React codebases use patterns the mini-CFG can't handle (early return + throw, nested guards, conditional assignments)
2. **Performance becomes a bottleneck** — analyzing 500+ modules in a large monorepo takes >10s
3. **eslint-scope causes new bugs** — scope bubbling or reference resolution creates another class of incorrectness
4. **Phantom goes open-source** — Rust addon gives a clear technical moat and performance story

Stay in JS when:
1. The current accuracy is sufficient for production use
2. Development velocity is more important than analysis correctness
3. The user base doesn't need Windows/Linux native builds
