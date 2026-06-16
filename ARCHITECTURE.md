# Phantom — Architecture & Data Flow

## High-Level Pipeline

```
                            ┌─────────────────────────────────────────────┐
                            │              Vite / Webpack                  │
                            │         (build tool orchestrator)            │
                            └──────┬────────────┬────────────┬────────────┘
                                   │            │            │
                              buildStart    transform     buildEnd
                                   │            │            │
                            ┌──────▼──────┐  ┌──▼──────────┐ ┌──▼──────────┐
                            │ Clear state │  │ Per-module  │ │ Write       │
                            │ Load cache  │  │ pipeline    │ │ manifest    │
                            │             │  │ (see below) │ │ Print       │
                            └─────────────┘  └─────────────┘ │ summary    │
                                                             └────────────┘
```

## Per-Module Transform Pipeline

Each `.tsx`/`.ts`/`.jsx`/`.js` file passes through 5 phases:

```
  Source Code
  ─────────────────────────────────────────────────────────────────
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: PARSE                                    (sync)      │
│  parseModule(code, filePath)                                   │
│  ─────────────────────────────────────                         │
│  • OXC parser → ESTree-compatible AST                          │
│  • eslint-scope → variable/scope analysis                      │
│  • Extract imports, function deps, captured vars               │
│                                                                │
│  Output: AnalyzedModule                                        │
│    { ast, functions[], imports[] }                              │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2: CLASSIFY                                 (sync)      │
│  classifyModule(analyzed, sourceCode)                           │
│  ─────────────────────────────────────                         │
│  • Taint analysis → which functions touch browser APIs?        │
│  • Taint propagation → follow call chains                      │
│  • Purity analysis → pure functions (no side effects)          │
│  • Hook context detection → useMemo, useCallback, etc.         │
│  • Event handler detection → onClick={fn}, onFocus={fn}        │
│  • Confidence scoring (0–1)                                    │
│                                                                │
│  Output: ClassifiedSegment[]                                   │
│    { id, name, classification, confidence, reasons[], deps[] } │
└────────────────┬──────────────────────┬─────────────────────────┘
                 │                      │
                 ▼                      ▼
┌────────────────────────────┐  ┌────────────────────────────────┐
│ PHASE 2b: COMPONENT        │  │ PHASE 3: LAZY DETECTION        │
│ PROFILE                    │  │ detectLazyCandidates(...)       │
│ ────────────────           │  │ ──────────────────────          │
│ Build cross-module profile │  │ • Find PascalCase imports      │
│ for downstream lazy detect │  │ • Map JSX usages + positions   │
│                            │  │ • Apply heuristic rules:       │
│ Output: ComponentProfile   │  │   - Context provider? → static │
│  { hasHandlers,            │  │   - Above fold? → static       │
│    hasState,               │  │   - Conditional? → interaction  │
│    hasEffects,             │  │   - Below fold? → viewport     │
│    handlerCount,           │  │ • Assign suspense groups       │
│    estimatedSize }         │  │                                │
│                            │  │ Output: LazyCandidateResult    │
│ Stored in shared map for   │  │  { lazy[], keepStatic[] }      │
│ other modules to reference │  │                                │
└────────────────────────────┘  └───────────────┬────────────────┘
                                                │
                                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 4: EXTRACTION                              (sync)       │
│  extractModule(analyzed, segments, code, threshold, path,       │
│                lazyCandidates)                                  │
│  ─────────────────────────────────────                         │
│  • Deep-clone AST                                              │
│  • For each EventHandler segment:                              │
│    - Resolve dependencies (imports, captured vars)             │
│    - Generate self-contained chunk module                      │
│    - Replace function body with __phantom_lazy() stub          │
│  • For each LazyCandidate:                                     │
│    - Rewrite import → const X = lazy(() => import('./X'))      │
│    - Wrap JSX usage in <Suspense fallback={null}>              │
│    - Add lazy/Suspense React imports                           │
│  • Print AST back to code via esrap                            │
│                                                                │
│  Output: ExtractionResult                                      │
│    { clientCode, clientMap, chunkModules[] }                   │
└──────────────┬──────────────────────────┬───────────────────────┘
               │                          │
               │    ┌─────────────────────┘
               │    │  (if LLM enabled + no cache hit)
               │    ▼
               │  ┌───────────────────────────────────────────────┐
               │  │  PHASE 5: LLM REFINEMENT          (async)    │
               │  │  DataLoader-style batched inference            │
               │  │  ──────────────────────────────               │
               │  │  • Enqueue into shared batch queue            │
               │  │  • 50ms debounce collects concurrent modules  │
               │  │  • ONE Cerebras API call for entire batch     │
               │  │  • LLM can: override prefetch strategies,     │
               │  │    assign suspense groups, move to static     │
               │  │  • If changes: re-run Phase 4 with refined    │
               │  │    candidates                                 │
               │  │  • Cache results for subsequent builds        │
               │  │                                               │
               │  │  Falls back to Phase 4 heuristic on failure   │
               │  └──────────────────┬────────────────────────────┘
               │                     │
               ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  REGISTRATION                                                   │
│  ──────────────                                                 │
│  • Store chunk modules in chunkModuleMap (for load() hook)     │
│  • Add manifest entries (handler + lazy kinds)                 │
│  • Track source→chunks mapping (for HMR cleanup)              │
│                                                                │
│  Return to Vite/Webpack: { code: clientCode, map: clientMap }  │
└─────────────────────────────────────────────────────────────────┘
```


## Worked Example 1: Event Handler Extraction

**Input: `event-handler.tsx`**

```tsx
import React, { useRef } from 'react';

export function InteractiveComponent() {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    const id = e.target.dataset.id;
    window.location.href = `/product/${id}`;
  };

  const handleFocus = () => {
    inputRef.current?.focus();
    document.body.classList.add('modal-open');
  };

  const handleScroll = () => {
    window.scrollTo(0, 0);
    localStorage.setItem('scrolled', 'true');
  };

  return (
    <div onClick={handleClick}>
      <input ref={inputRef} onFocus={handleFocus} />
      <button onClick={handleScroll}>Top</button>
    </div>
  );
}
```

### Phase 1 Output: AnalyzedModule

```
functions:
  ┌────────────────────────┬────────────────────┬──────────┬───────────────────────────────────┐
  │ name                   │ locals             │ captured │ globals                           │
  ├────────────────────────┼────────────────────┼──────────┼───────────────────────────────────┤
  │ InteractiveComponent   │ inputRef,          │ (none)   │ window, document, localStorage    │
  │                        │ handleClick,       │          │                                   │
  │                        │ handleFocus,       │          │                                   │
  │                        │ handleScroll       │          │                                   │
  ├────────────────────────┼────────────────────┼──────────┼───────────────────────────────────┤
  │ handleClick            │ e, id              │ (none)   │ window                            │
  ├────────────────────────┼────────────────────┼──────────┼───────────────────────────────────┤
  │ handleFocus            │ (none)             │ inputRef │ document                          │
  ├────────────────────────┼────────────────────┼──────────┼───────────────────────────────────┤
  │ handleScroll           │ (none)             │ (none)   │ window, localStorage              │
  └────────────────────────┴────────────────────┴──────────┴───────────────────────────────────┘

imports:
  react → { React (default), useRef (named) }
```

### Phase 2 Output: ClassifiedSegment[]

```
  ┌──────────────────────────────┬─────────────────┬────────┬──────────────────────────────────┐
  │ id                           │ classification   │ conf.  │ reason                           │
  ├──────────────────────────────┼─────────────────┼────────┼──────────────────────────────────┤
  │ seg_0b24..  InteractiveComp  │ ClientInteractve │ 0.95   │ References: window, document,    │
  │             (parent)         │                  │        │ localStorage                     │
  ├──────────────────────────────┼─────────────────┼────────┼──────────────────────────────────┤
  │ seg_01b6..  handleClick      │ EventHandler ✓   │ 0.90   │ Event handler for onClick        │
  │             deps: []         │                  │        │                                  │
  ├──────────────────────────────┼─────────────────┼────────┼──────────────────────────────────┤
  │ seg_9b6f..  handleFocus      │ EventHandler ✓   │ 0.90   │ Event handler for onFocus        │
  │             deps: [inputRef] │                  │        │                                  │
  ├──────────────────────────────┼─────────────────┼────────┼──────────────────────────────────┤
  │ seg_32d5..  handleScroll     │ EventHandler ✓   │ 0.90   │ Event handler for onClick        │
  │             deps: []         │                  │        │                                  │
  └──────────────────────────────┴─────────────────┴────────┴──────────────────────────────────┘
```

### Phase 3 Output: LazyCandidateResult

```
  lazy:       []    ← No child component imports in this file
  keepStatic: []
```

### Phase 4 Output: ExtractionResult

**Client code** (returned to Vite/Webpack — this is what ships to the browser initially):

```tsx
import { __phantom_lazy } from 'phantom-build/runtime';
import React, { useRef } from 'react';

export function InteractiveComponent() {
  const inputRef = useRef(null);

  const handleClick = (e) => {                              // ← shell preserved
    e.persist?.();                                          // ← event persisted
    __phantom_lazy(                                         // ← body replaced
      () => import('phantom:seg_01b6063a6ad3.chunk.js'),    //    with lazy stub
      'seg_01b6063a6ad3',
      e                                                     //    forwards event arg
    );
  };

  const handleFocus = () =>
    __phantom_lazy(
      () => import('phantom:seg_9b6fb74f334d.chunk.js'),
      'seg_9b6fb74f334d',
      inputRef                                              // ← captured var forwarded
    );

  const handleScroll = () =>
    __phantom_lazy(
      () => import('phantom:seg_32d5e58b5f95.chunk.js'),
      'seg_32d5e58b5f95'                                    // ← no deps needed
    );

  return (
    <div onClick={handleClick}>
      <input ref={inputRef} onFocus={handleFocus} />
      <button onClick={handleScroll}>Top</button>
    </div>
  );
}
```

**Chunk modules** (loaded on-demand when handler fires):

```
 ┌─ seg_01b6063a6ad3.chunk.js ────────────────┐
 │                                             │
 │  export function seg_01b6063a6ad3(e) {      │
 │    const id = e.target.dataset.id;          │
 │    window.location.href = `/product/${id}`; │
 │  }                                          │
 │                                             │
 └─────────────────────────────────────────────┘

 ┌─ seg_9b6fb74f334d.chunk.js ────────────────┐
 │                                             │
 │  export function seg_9b6fb74f334d(inputRef) │
 │    inputRef.current?.focus();               │
 │    document.body.classList.add('modal-open');│
 │  }                                          │
 │                                             │
 └─────────────────────────────────────────────┘

 ┌─ seg_32d5e58b5f95.chunk.js ────────────────┐
 │                                             │
 │  export function seg_32d5e58b5f95() {       │
 │    window.scrollTo(0, 0);                   │
 │    localStorage.setItem('scrolled', 'true');│
 │  }                                          │
 │                                             │
 └─────────────────────────────────────────────┘
```

**Runtime flow when user clicks:**
```
  User clicks <div>
       │
       ▼
  handleClick(e) runs  ← shell function in main bundle
       │
       ▼
  __phantom_lazy(
    () => import('phantom:seg_01b6063a6ad3.chunk.js'),  ← dynamic import
    'seg_01b6063a6ad3',
    e                                                   ← event arg forwarded
  )
       │
       ▼
  Vite/Webpack resolves virtual module
       │
       ▼
  chunk.js loaded → seg_01b6063a6ad3(e) executes
       │
       ▼
  window.location.href = '/product/123'
```


## Worked Example 2: Lazy Component Detection + Suspense Wrapping

**Input: `pages/CheckoutPage.tsx`**

```tsx
import React, { useState, useCallback } from 'react';
import { CartProvider } from './CartProvider';   // wraps children → provider
import { CartItems } from './CartItems';         // position 0, interactive
import { OrderSummary } from './OrderSummary';   // position 1, display only
import { PaymentForm } from './PaymentForm';     // position 2, heavy interactive
import { AddressForm } from './AddressForm';     // position 3, interactive
import { PromoCode } from './PromoCode';         // conditional, rarely used
import { OrderHistory } from './OrderHistory';   // conditional, optional section

export default function CheckoutPage({ order, user }) {
  const [showPromo, setShowPromo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const handleTogglePromo = useCallback(() => {
    setShowPromo((prev) => !prev);
  }, []);

  return (
    <CartProvider cartId={order.cartId}>
      <div className="checkout-layout">
        <CartItems items={order.items} />
        <OrderSummary totals={order.totals} />
        <PaymentForm userId={user.id} />
        <AddressForm userId={user.id} defaultAddress={user.address} />
        {showPromo && <PromoCode cartId={order.cartId} />}
        <button onClick={handleTogglePromo}>Have a promo code?</button>
        {showHistory && <OrderHistory userId={user.id} />}
      </div>
    </CartProvider>
  );
}
```

### Phase 3 Decision Tree

For a route component (path contains `/pages/`), each child component import is evaluated:

```
  Import                 Rule Applied                          Result
  ──────────────────────────────────────────────────────────────────────────

  CartProvider           Name ends with "Provider"             ✗ KEEP STATIC
                         → must hydrate before consumers         reason: Context provider

  CartItems              Position 0 in route component         ✗ KEEP STATIC
                         → above fold (threshold = 2)            reason: above fold

  OrderSummary           Position 1 in route component         ✗ KEEP STATIC
                         → above fold (threshold = 2)            reason: above fold

  PaymentForm            Position 2 in route component         ✓ LAZY
                         → below fold                            prefetch: viewport
                         Adjacent to AddressForm                 group: group_0

  AddressForm            Position 3 in route component         ✓ LAZY
                         → below fold                            prefetch: viewport
                         Adjacent to PaymentForm                 group: group_0

  PromoCode              Inside {showPromo && <...>}           ✓ LAZY
                         → conditionally rendered                prefetch: interaction
                                                                 group: null (solo)

  OrderHistory           Inside {showHistory && <...>}         ✓ LAZY
                         → conditionally rendered                prefetch: interaction
                                                                 group: null (solo)
```

### Phase 3 Output: LazyCandidateResult

```
  ┌────────────────┬──────────────┬─────────┬─────────────┬───────────────────────────────────┐
  │ localName      │ prefetch     │ cond?   │ suspGroup   │ reason                            │
  ├────────────────┼──────────────┼─────────┼─────────────┼───────────────────────────────────┤
  │ PaymentForm    │ viewport     │ no      │ group_0     │ position 2 (below fold)           │
  │ AddressForm    │ viewport     │ no      │ group_0     │ position 3 (below fold)           │
  │ PromoCode      │ interaction  │ yes     │ null        │ conditionally rendered             │
  │ OrderHistory   │ interaction  │ yes     │ null        │ conditionally rendered             │
  └────────────────┴──────────────┴─────────┴─────────────┴───────────────────────────────────┘

  keepStatic:
  ┌────────────────┬──────────────────────────────────────────────────────────────────────────┐
  │ CartProvider   │ Context provider — must hydrate before consumers                        │
  │ CartItems      │ Position 0 in route component — above fold (threshold: 2)               │
  │ OrderSummary   │ Position 1 in route component — above fold (threshold: 2)               │
  └────────────────┴──────────────────────────────────────────────────────────────────────────┘
```

### Phase 3 Safety Rules (disqualified before any prefetch decision)

Before a component is considered for lazy loading, it must survive a set of
safety gates. These run ahead of the fold/conditional heuristics above — a
component that hits any of them is never lazified (see `src/classify/lazy.ts`):

```
  Rule                              Why                                       Result
  ─────────────────────────────────────────────────────────────────────────────────────
  Namespace import                  `import * as X` has no single default/      not a
  (import * as X)                   named binding for React.lazy to resolve.    candidate

  Used as a runtime value           React.lazy returns an opaque                KEEP STATIC
  (not only as a <X /> tag)         LazyExoticComponent, valid only as a
                                    Suspense-wrapped JSX child. Value uses
                                    like `X.displayName`, `component={X}`,
                                    `memo(X)`, or `X()` would break.

  Context provider                  Must hydrate before its consumers render.   KEEP STATIC
  (name ends Provider/Context,
   or wraps JSX children)

  Above the fold                    Suspense overhead + a loading waterfall     KEEP STATIC
  (position < 2 in a route)         hurt LCP for initial-viewport content.

  Low JS cost                       Below the size threshold the Suspense       KEEP STATIC
  (when a profile is available)     boundary costs more than it saves.
```

Note on the value-usage rule: TypeScript *type* positions (`typeof X`, `: X`,
`X<…>`) are erased at build time and do **not** disqualify a component, but
value-carrying TS expressions (`X as T`, `X!`, `X satisfies T`) keep `X` as a
runtime value and **do** keep it static. The rule is conservative by design: a
false positive only forgoes an optimization, it never emits code that breaks.

### Phase 4 Output: Lazy Transforms Applied

The extraction phase rewrites the imports and JSX:

```tsx
// BEFORE (original imports):
import { PaymentForm } from './PaymentForm';
import { AddressForm } from './AddressForm';
import { PromoCode } from './PromoCode';
import { OrderHistory } from './OrderHistory';

// AFTER (lazy-wrapped):
import { lazy, Suspense } from 'react';

const PaymentForm = lazy(() =>
  import('./PaymentForm').then(m => ({ default: m.PaymentForm }))
);
const AddressForm = lazy(() =>
  import('./AddressForm').then(m => ({ default: m.AddressForm }))
);
const PromoCode = lazy(() =>
  import('./PromoCode').then(m => ({ default: m.PromoCode }))
);
const OrderHistory = lazy(() =>
  import('./OrderHistory').then(m => ({ default: m.OrderHistory }))
);
```

```tsx
// BEFORE (JSX):
<PaymentForm userId={user.id} />
<AddressForm userId={user.id} defaultAddress={user.address} />
{showPromo && <PromoCode cartId={order.cartId} />}
{showHistory && <OrderHistory userId={user.id} />}

// AFTER (Suspense-wrapped):

// ┌─ group_0 ─────────────────────────────────────────────────┐
// │ Adjacent siblings share ONE Suspense boundary             │
<Suspense fallback={null}>
  <PaymentForm userId={user.id} />
  <AddressForm userId={user.id} defaultAddress={user.address} />
</Suspense>
// └───────────────────────────────────────────────────────────┘

// Solo Suspense boundaries for conditional components:
{showPromo && <Suspense fallback={null}><PromoCode cartId={order.cartId} /></Suspense>}

{showHistory && <Suspense fallback={null}><OrderHistory userId={user.id} /></Suspense>}
```

### What Stays Static (untouched)

```tsx
// These imports are NOT rewritten — they load in the initial bundle:
import { CartProvider } from './CartProvider';   // ← Context provider
import { CartItems } from './CartItems';         // ← Above fold (position 0)
import { OrderSummary } from './OrderSummary';   // ← Above fold (position 1)

// Their JSX stays as-is:
<CartProvider cartId={order.cartId}>
  <CartItems items={order.items} />              // ← renders immediately
  <OrderSummary totals={order.totals} />         // ← renders immediately
  ...
</CartProvider>
```


## Phase 5: LLM Refinement (DataLoader Pattern)

When `cerebrasApiKey` is set, the LLM can override heuristic decisions:

```
  transform(A.tsx)──┐
                    │  enqueue                ┌───────────────────────┐
  transform(B.tsx)──┤──────────►  batch       │                       │
                    │  queue      50ms        │  Cerebras API         │
  transform(C.tsx)──┘            debounce     │  (qwen-3-32b)        │
                                    │         │                       │
                                    ▼         │  Single request with  │
                              ┌──────────┐    │  ALL modules' IR      │
                              │  flush   │───►│                       │
                              └──────────┘    │  Cross-module aware:  │
                                    │         │  - Shared state       │
                                    │         │  - Common imports     │
                              ┌─────▼──────┐  │  - Consistent        │
                              │  Response  │◄─┤    strategies         │
                              └─────┬──────┘  │                       │
                                    │         └───────────────────────┘
                  ┌─────────────────┼─────────────────┐
                  ▼                 ▼                  ▼
            resolve(A)        resolve(B)         resolve(C)
            with refined      with refined       with refined
            candidates        candidates         candidates
```

### LLM IR (what gets sent)

```json
{
  "modules": [
    {
      "parent": "CheckoutPage",
      "file": "pages/CheckoutPage.tsx",
      "candidates": [
        {
          "name": "PaymentForm",
          "source": "./PaymentForm",
          "jsxPosition": 2,
          "conditional": false,
          "hasHandlers": true,
          "hasState": true,
          "estimatedSize": 8500,
          "heuristicPrefetch": "viewport",
          "heuristicReason": "position 2 (below fold)"
        }
      ],
      "keptStatic": [
        { "name": "CartProvider", "reason": "Context provider" }
      ]
    }
  ],
  "totalCandidates": 4
}
```

### LLM Response (what comes back)

```json
{
  "modules": {
    "pages/CheckoutPage.tsx": {
      "decisions": [
        {
          "name": "PaymentForm",
          "prefetch": "immediate",
          "suspenseGroup": "checkout_forms",
          "confidence": 0.95,
          "reason": "critical checkout path — user expects instant form"
        },
        {
          "name": "AddressForm",
          "prefetch": "immediate",
          "suspenseGroup": "checkout_forms",
          "confidence": 0.92,
          "reason": "required for checkout completion"
        }
      ],
      "overrideToStatic": [],
      "insights": ["PaymentForm and AddressForm share form validation context"]
    }
  },
  "globalInsights": ["Consider co-locating PaymentForm and AddressForm chunks"]
}
```

### Merge: What changes

```
  Before LLM:                           After LLM:
  ──────────────                         ──────────
  PaymentForm  → viewport               PaymentForm  → immediate  (upgraded!)
                  group_0                                checkout_forms
  AddressForm  → viewport               AddressForm  → immediate  (upgraded!)
                  group_0                                checkout_forms
  PromoCode    → interaction             PromoCode    → interaction (confirmed)
  OrderHistory → interaction             OrderHistory → interaction (confirmed)
```

If any candidate changes, Phase 4 re-runs with the refined candidates so the
**actual emitted code** reflects LLM decisions on the first build.


## Prefetch Strategy → Browser Behavior

```
  Strategy      When Loaded                  Use Case
  ──────────────────────────────────────────────────────────────────
  immediate     <link rel="modulepreload">   Critical path components.
                Starts loading NOW.          User needs them immediately.

  viewport      Intersection Observer or     Below-fold content.
                <link rel="prefetch">        Load as user scrolls toward it.

  interaction   On user action (click,       Modals, dropdowns, tabs.
                hover, focus).               Only load if user engages.

  idle          requestIdleCallback or       Background features.
                setTimeout fallback.         Load when browser is free.
```


## Manifest Output

After `buildEnd`, phantom writes `phantom.manifest.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "segmentId": "seg_01b6063a6ad3",
      "sourceFile": "event-handler.tsx",
      "virtualId": "\u0000phantom:seg_01b6063a6ad3.chunk.js",
      "name": "event_handler_handleClick",
      "kind": "handler"
    },
    {
      "segmentId": "lazy_PaymentForm",
      "sourceFile": "pages/CheckoutPage.tsx",
      "virtualId": "./PaymentForm",
      "name": "lazy(PaymentForm)",
      "kind": "lazy"
    }
  ],
  "stats": {
    "totalModulesProcessed": 15,
    "totalSegmentsExtracted": 12
  }
}
```

## RSC Readiness Analysis Pass (`phantom rsc`)

Separate from the per-module build transform, `phantom rsc <dir>` runs a whole-project, read-only analysis that produces a React Server Components migration map. It **reuses** the parser (`parseModule`) and the SSR-boundary classifier (`classifyModuleSSR`), then adds cross-module graph analysis on top. It never emits or mutates code.

It is a pipeline of five isolated units in `src/rsc/`:

```
files (*.tsx/*.ts/*.jsx/*.js)
  → parse + SSR-classify each              (reuse: analyzer + classifier)
  → per-file RSC verdict + reasons         (unit 2: classify-rsc.ts)
  → resolve import edges → component graph  (unit 1: resolve-graph.ts)
  → propagate contagion → closure, realizable-server, minimal frontier (unit 3: contagion.ts)
  → rescue + hazard detection              (unit 4: rescue-hazards.ts)
  → emit human + JSON report               (unit 5: report.ts)
```

1. **Graph resolver** (`resolve-graph.ts`): the highest-risk unit. It resolves every relative, `tsconfig`-alias (`@/...`, via `get-tsconfig`), and one-hop barrel (`index.ts` re-export) import to a concrete file, and reports an edge-resolution coverage fraction. Missed edges under-propagate client-ness, so this unit is heavily tested and gated at >=90% resolution on real corpora (it reaches 100% on shadcn-admin and bulletproof-react).

2. **RSC classifier** (`classify-rsc.ts`): maps the SSR classification to an RSC verdict. `FullyStatic` becomes `server-eligible`; `SSRSafe` or `ClientOnly` becomes `must-be-client`. The subtlety is that `SSRSafe` means "safe to server-render for first paint" (a `useState` component qualifies), which is broader than "can be a Server Component," so a stateful component is correctly `must-be-client`. A file is `mixed` (a split candidate) when it contains both a server-eligible and a must-be-client component.

3. **Contagion + frontier** (`contagion.ts`): pure graph algorithms. Seeds are files that are intrinsically client. Client-ness propagates forward along import edges, importer to imported: a client file's imports are also client. The result is the client closure, the realizable-server set (server-eligible files not in the closure), and the minimal `'use client'` frontier (the topmost client files; a cyclic client group with no acyclic entry gets one representative, so a needed directive is never omitted).

4. **Rescue + hazard detection** (`rescue-hazards.ts`): shallow heuristics. A rescue candidate is a server-eligible file pulled into the closure by exactly one direct client importer, which can often be passed as `children` to stay on the server (since `children` is not an import). A hazard is a function or class instance passed as a prop to a must-be-client component from a server-eligible file. React elements and primitives are serializable across the boundary and are not flagged.

5. **Report** (`report.ts`) and **orchestrator** (`index.ts`): `analyzeRscReadiness(dir)` runs units 1 through 4 and assembles an `RscReport`; `report.ts` renders it as terminal text, markdown, or stable JSON.

**Conservative bias throughout.** When unsure, the analysis prefers `must-be-client` (safe) over `server-eligible` (unsafe), and it always prints the import-edge resolution coverage next to any realizable-server figure so the number can be judged.

## File Map

```
src/
├── plugin.ts                 Plugin entry — buildStart, transform, load, buildEnd
│                             DataLoader-style LLM batch queue
│
├── analyzer.ts               Phase 1 — OXC parse + scope analysis
│                             Exports: parseModule(), analyzeModule()
│
├── classify/
│   ├── index.ts              Phase 2 — taint, purity, handler detection
│   │                         Exports: classifyModule(), detectLazyCandidates()
│   ├── lazy.ts               Phase 3 — heuristic lazy candidate detection
│   │                         Rules: fold position, conditional, context provider
│   ├── lazy-llm.ts           Phase 5 — LLM IR schema, prompts, merge logic
│   │                         Types: LazyIR, LazyLLMResponse, BatchedLazyIR
│   └── llm-client.ts         Phase 5 — Cerebras API client (single + batched)
│                             Exports: refineLazyCandidatesBatched()
│
├── extract/
│   ├── index.ts              Phase 4 — handler extraction + code generation
│   │                         Exports: extractModule()
│   └── lazy-transform.ts     Phase 4 — React.lazy() + Suspense AST mutations
│                             Exports: applyLazyTransforms()
│
├── rsc/                      RSC readiness analysis (`phantom rsc`), read-only
│   ├── types.ts              RscVerdict, RscFileResult, ComponentGraph, RscReport
│   ├── classify-rsc.ts       unit 2: per-file RSC verdict from SSR classification
│   ├── resolve-graph.ts      unit 1: import graph (relative + alias + barrel) + coverage
│   ├── contagion.ts          unit 3: client closure, realizable-server, minimal frontier
│   ├── rescue-hazards.ts     unit 4: children-rescue + serialization hazards
│   ├── report.ts             unit 5: toJSON / toMarkdown / toTerminal
│   └── index.ts              orchestrator: analyzeRscReadiness(dir)
│
├── types.ts                  All shared type definitions
├── index.ts                  Public API exports
├── cli.ts                    CLI: `phantom analyze <file>`, `phantom rsc <dir>`
├── ast-compat.ts             OXC → ESTree metadata patching
└── vite.ts / webpack.ts      Framework-specific plugin exports
```
