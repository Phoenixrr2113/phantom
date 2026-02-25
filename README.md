# Phantom

**Automatic code-splitting for React event handlers and components.**

Phantom is a build plugin that analyzes your React code, extracts event handlers into lazy-loaded chunks, and wraps below-fold components in `React.lazy` + `Suspense` — all automatically, with zero config changes to your components.

```bash
npm install phantom-build
```

## What It Does

Phantom runs at build time (Vite or Webpack) and does two things:

**1. Handler extraction** — Event handlers that touch browser APIs (`window`, `document`, `localStorage`, etc.) are extracted into separate chunks and loaded on-demand when the user first interacts.

**2. Lazy component wrapping** — Child components below the fold in route-level pages are automatically wrapped in `React.lazy()` + `<Suspense>`, so they don't block initial page load.

Your source code stays unchanged. Phantom transforms the output at build time.

## Quick Start

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import phantom from 'phantom-build/vite';

export default defineConfig({
  plugins: [
    phantom(),
    react(),
  ],
});
```

### Webpack

```js
// webpack.config.js
import phantom from 'phantom-build/webpack';

export default {
  // ...
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: { transpileOnly: true },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    phantom(),
  ],
};
```

That's it. Run your build and Phantom handles the rest.

## How It Works

### Handler Extraction

Given this component:

```tsx
export function InteractiveComponent() {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    window.location.href = `/product/${e.target.dataset.id}`;
  };

  const handleScroll = () => {
    window.scrollTo(0, 0);
    localStorage.setItem('scrolled', 'true');
  };

  return (
    <div onClick={handleClick}>
      <button onClick={handleScroll}>Top</button>
    </div>
  );
}
```

Phantom produces:

- **Client code** — handlers are replaced with lightweight stubs that lazy-load the real logic on first click
- **Chunk modules** — each handler's logic lives in its own small file, loaded on demand

The stub calls `e.preventDefault()` and `e.stopPropagation()` synchronously (before the import), so critical event behavior is never delayed. The heavy logic (`window.location.href`, `localStorage`, etc.) loads asynchronously.

### Lazy Component Wrapping

Given a route-level page component:

```tsx
import { CartItems } from './CartItems';
import { OrderSummary } from './OrderSummary';
import { PaymentForm } from './PaymentForm';
import { AddressForm } from './AddressForm';
import { PromoCode } from './PromoCode';

export default function CheckoutPage({ order, user }) {
  const [showPromo, setShowPromo] = useState(false);

  return (
    <CartProvider cartId={order.cartId}>
      <CartItems items={order.items} />
      <OrderSummary totals={order.totals} />
      <PaymentForm userId={user.id} />
      <AddressForm userId={user.id} />
      {showPromo && <PromoCode cartId={order.cartId} />}
    </CartProvider>
  );
}
```

Phantom transforms this to:

```tsx
import { CartItems } from './CartItems';
import { OrderSummary } from './OrderSummary';

const PaymentForm = lazy(() =>
  import('./PaymentForm').then(m => ({ default: m.PaymentForm }))
);
const AddressForm = lazy(() =>
  import('./AddressForm').then(m => ({ default: m.AddressForm }))
);
const PromoCode = lazy(() =>
  import('./PromoCode').then(m => ({ default: m.PromoCode }))
);

export default function CheckoutPage({ order, user }) {
  const [showPromo, setShowPromo] = useState(false);

  return (
    <CartProvider cartId={order.cartId}>
      {/* Kept static: above fold */}
      <CartItems items={order.items} />
      <OrderSummary totals={order.totals} />

      {/* Lazy: adjacent siblings share one Suspense boundary */}
      <Suspense fallback={null}>
        <PaymentForm userId={user.id} />
        <AddressForm userId={user.id} />
      </Suspense>

      {/* Lazy: conditionally rendered, own boundary */}
      {showPromo && (
        <Suspense fallback={null}>
          <PromoCode cartId={order.cartId} />
        </Suspense>
      )}
    </CartProvider>
  );
}
```

**What stays static (not lazified):**
- Components above the fold (positions 0-1 in the JSX tree)
- Context providers (must hydrate before consumers)
- Components with no meaningful JS cost (pure display, no handlers/effects/state)

**What gets lazified:**
- Components below the fold (position 2+)
- Conditionally rendered components (`{flag && <Component />}`)
- Components with handlers, effects, or state (worth deferring)

## Configuration

```ts
phantom({
  // Confidence threshold for handler extraction (0.0 - 1.0)
  // Lower = more aggressive extraction. Default: 0.8
  confidenceThreshold: 0.8,

  // Enable/disable lazy component wrapping. Default: true
  enableLazy: true,

  // Output path for the build manifest. Default: "phantom.manifest.json"
  manifestPath: 'phantom.manifest.json',

  // Suppress console output during build. Default: false
  silent: false,

  // Cerebras API key for LLM-assisted optimization (optional)
  cerebrasApiKey: process.env.CEREBRAS_API_KEY,

  // Cerebras model ID. Default: "qwen-3-32b"
  cerebrasModel: 'qwen-3-32b',

  // SSR mode: skip all transforms for server builds. Default: false
  ssr: false,
})
```

### SSR (Server-Side Rendering)

Phantom supports custom SSR setups where you run separate client and server builds. `React.lazy()` throws when used with `renderToString()`, so the server bundle needs original code with synchronous imports.

**The solution:** run Phantom with `ssr: true` for your server build. This makes the plugin a complete no-op — your server bundle gets untouched source code.

#### Vite

```ts
// vite.config.server.ts
import phantom from 'phantom-build/vite';

export default defineConfig({
  plugins: [
    phantom({ ssr: true }),
    react(),
  ],
});
```

#### Webpack

```js
// webpack.config.server.js
import phantom from 'phantom-build/webpack';

export default {
  target: 'node',
  plugins: [
    phantom({ ssr: true }),
  ],
};
```

#### Typical Setup

Most custom SSR setups (e.g., .NET + React, Express + React) use two bundler configs:

```
webpack.config.client.js  →  phantom()               // full transforms
webpack.config.server.js  →  phantom({ ssr: true })   // no-op
```

The client build produces lazy-loaded handler chunks and `React.lazy` wrappers. The server build produces a synchronous bundle for `renderToString()` with all components inline.

**Why not strip just `React.lazy`?** Selectively removing lazy transforms while keeping handler extraction would still inject `__phantom_lazy` runtime imports and dynamic `import()` calls into the server bundle. A clean no-op is simpler, produces the smallest server bundle, and avoids any SSR-incompatible code paths.

### LLM-Assisted Optimization

Phantom's heuristics handle ~80% of cases correctly. For the remaining 20% that require judgment (grouping related components, choosing prefetch strategies for ambiguous cases), you can enable LLM refinement:

```bash
# .env
CEREBRAS_API_KEY=your_key_here
```

```ts
phantom({
  cerebrasApiKey: process.env.CEREBRAS_API_KEY,
})
```

The LLM call is batched across modules (one API call per build), results are cached to disk (`*.lazy-cache.json`), and failures fall back to heuristics silently. The LLM never blocks your build.

## CLI

Phantom includes a CLI for analyzing individual files:

```bash
npx phantom analyze src/components/CheckoutPage.tsx
```

Output:

```
Phantom Analysis: src/components/CheckoutPage.tsx
════════════════════════════════════════════════════════════

  Name                           Class                Conf  Extracted?
  ────────────────────────────── ──────────────────── ────── ──────────
  handleTogglePromo              EventHandler         0.95  ✓ yes
    → JSX event handler prop: onClick
    → Browser API: window referenced

  Segments: 5
  Threshold: 0.8
  Chunks extracted: 1
    seg_abc123 (0.1 KB)

  Lazy Components:
  Name                      Strategy     Group
  ───────────────────────── ──────────── ───────────────
  PaymentForm               viewport     group_0
  AddressForm               viewport     group_0
  PromoCode                 interaction  (solo)

  Kept Static:
    CartItems                 → Position 0 in route component — above fold
    OrderSummary              → Position 1 in route component — above fold
    CartProvider              → Context provider — must hydrate before consumers
```

### CLI Options

```
phantom analyze <file> [options]

Options:
  --threshold <number>   Confidence threshold for extraction (default: 0.8)
  --help, -h             Show this help message
```

## Build Manifest

Each build produces a `phantom.manifest.json` describing all extractions:

```json
{
  "version": 1,
  "entries": [
    {
      "segmentId": "seg_01b6063a6ad3",
      "sourceFile": "/src/InteractiveComponent.tsx",
      "virtualId": "phantom:seg_01b6063a6ad3.chunk.js",
      "name": "handleClick",
      "kind": "handler"
    },
    {
      "segmentId": "lazy_PaymentForm",
      "sourceFile": "/src/CheckoutPage.tsx",
      "virtualId": "./PaymentForm",
      "name": "lazy(PaymentForm)",
      "kind": "lazy"
    }
  ],
  "stats": {
    "totalModulesProcessed": 42,
    "totalSegmentsExtracted": 12
  }
}
```

## Architecture Overview

Phantom processes each module through a 5-phase pipeline:

1. **Parse** — OXC parser produces an ESTree AST; eslint-scope resolves variable bindings
2. **Classify** — Three-pass analysis (taint, purity, boundary detection) classifies each function as `EventHandler`, `PureComputation`, `ClientInteractive`, `Shared`, or `Ambiguous`
3. **Lazy Detection** — Identifies child component imports that should be `React.lazy` wrapped, using JSX position, conditionality, and cross-module component profiles
4. **Extract** — Rewrites the AST: handler bodies move to virtual chunk modules, component imports become `lazy()` declarations, JSX gets `<Suspense>` wrappers
5. **LLM Refinement** (optional) — Batched API call refines prefetch strategies and Suspense grouping for edge cases

### Classification Rules

| Classification | Criteria | Action |
|---|---|---|
| `EventHandler` | Used exclusively as JSX event prop (`onClick`, `onSubmit`, etc.), references browser APIs | Extracted to lazy chunk |
| `PureComputation` | No browser globals, no side effects, deterministic | Kept inline |
| `ClientInteractive` | Browser APIs but not an event handler (effects, observers) | Kept inline |
| `Shared` | Mix of pure and impure, or component render function | Kept inline |
| `Ambiguous` | Below confidence threshold | Kept inline (conservative) |

### Prefetch Strategies

| Strategy | When Used | Behavior |
|---|---|---|
| `viewport` | Below-fold components | Load when element enters viewport (IntersectionObserver) |
| `interaction` | Conditionally rendered components | Load on user interaction that triggers render |
| `idle` | Components with effects | Load during `requestIdleCallback` |
| `immediate` | LLM-determined critical paths | Load immediately after initial render |

## How the Runtime Works

The `phantom-build/runtime` module provides `__phantom_lazy`, which:

1. On first invocation, dynamically imports the handler chunk
2. Caches the loaded function for instant subsequent calls
3. Deduplicates concurrent imports (rapid clicks don't trigger multiple fetches)
4. Cleans up on failure so retries work

```ts
import { __phantom_lazy } from 'phantom-build/runtime';

// Generated stub (you never write this — Phantom does):
const handleClick = (e) => {
  e.preventDefault();        // synchronous — runs immediately
  e.persist?.();             // React <17 compat
  __phantom_lazy(
    () => import('phantom:seg_abc123.chunk.js'),
    'seg_abc123',
    e,                       // forwarded args
    inputRef,                // captured variables
  );
};
```

## Barrel File Support

Phantom resolves through barrel files automatically. If your components use index re-exports:

```ts
// components/index.ts
export { PaymentForm } from './PaymentForm';
export { AddressForm } from './AddressForm';
```

```tsx
// CheckoutPage.tsx
import { PaymentForm, AddressForm } from './components';
```

The generated `lazy()` calls will target the actual component modules (`./components/PaymentForm`), not the barrel file — producing optimal chunk splitting.

## Benchmarks

Tested against [shadcn-admin](https://github.com/satnaing/shadcn-admin) (11k+ stars) — a production-grade admin dashboard built with React 19, Vite 6, TanStack Router, and Shadcn UI.

### Route-Level JS Reduction

Phantom reduces the JavaScript that loads when navigating to each page. Shared dependencies (React, Radix, etc.) are identical between builds — only route-specific code changes.

| Route | Baseline | Phantom | Reduction |
|---|---|---|---|
| Main layout (`_authenticated`) | 336 KB | 10.7 KB | **−97%** |
| Settings → Account | 52.9 KB | 1.1 KB | **−98%** |
| Auth → OTP | 12.6 KB | 1.2 KB | **−90%** |
| Settings → Notifications | 7.1 KB | 1.0 KB | **−86%** |
| Settings → Appearance | 4.3 KB | 1.0 KB | **−75%** |
| **Total (29 routes)** | **480 KB** | **77.5 KB** | **−84%** |

57 interaction handlers (modals, dialogs, dropdowns) are deferred to on-demand chunks totaling 5.3 KB. These load only when the user actually clicks.

### Lighthouse (Simulated Slow 4G + 4× CPU Throttling)

| Metric | Baseline | Phantom | Change |
|---|---|---|---|
| Total Blocking Time | 32 ms | 6 ms | **−83%** |
| First Contentful Paint | 3.18 s | 3.18 s | — |
| Performance Score | 80 | 79 | −1 |
| Build Time | 3.7 s | 4.1 s | +8% |

Total Blocking Time measures how long the main thread is locked and unable to respond to user input. Phantom reduces it by 83% because route chunks contain far less JavaScript to parse and compile.

### Reproduce

```bash
# Clone the repo and install
git clone https://github.com/Phoenixrr2113/phantom.git
cd phantom && npm install && npm run build

# Route chunk comparison
node benchmarks/compare-routes.mjs

# Lighthouse A/B comparison
node benchmarks/lighthouse-compare.mjs --runs=5
```

## Requirements

- Node.js >= 18
- React 16.6+ (for `React.lazy` and `Suspense`)
- Vite or Webpack
- For SSR: any custom server setup (Express, .NET, etc.) — not framework-specific

## License

MIT
