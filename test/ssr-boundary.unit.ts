import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseModule } from '../src/analyzer.js';
import { classifyModuleWithContext, classifyModuleSSR } from '../src/classify/index.js';
import type { SSRComponentResult, SSRModuleResult } from '../src/types.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

/** Helper: run SSR boundary analysis on inline code */
function analyzeSSR(code: string, path = 'test.tsx'): SSRModuleResult {
  const parsed = parseModule(code, path);
  const context = classifyModuleWithContext(parsed, code);
  return classifyModuleSSR(parsed, code, context);
}

/** Find an SSR component result by name */
function compByName(result: SSRModuleResult, name: string): SSRComponentResult | undefined {
  return result.components.find((c) => c.name === name);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('SSR boundary detection', () => {
  describe('component identification', () => {
    it('identifies PascalCase functions with JSX as components', () => {
      const result = analyzeSSR(`
        export function MyComponent() {
          return <div>hello</div>;
        }
      `);
      expect(result.components).toHaveLength(1);
      expect(result.components[0].name).toBe('MyComponent');
    });

    it('ignores camelCase functions', () => {
      const result = analyzeSSR(`
        export function myHelper() {
          return <div>hello</div>;
        }
      `);
      expect(result.components).toHaveLength(0);
    });

    it('ignores functions without JSX', () => {
      const result = analyzeSSR(`
        export function ComputeValue(x: number) {
          return x * 2;
        }
      `);
      expect(result.components).toHaveLength(0);
    });

    it('identifies multiple components in one module', () => {
      const result = analyzeSSR(`
        export function Header() {
          return <header>Header</header>;
        }
        export function Footer() {
          return <footer>Footer</footer>;
        }
      `);
      expect(result.components).toHaveLength(2);
    });
  });

  describe('FullyStatic classification', () => {
    it('classifies pure props→JSX as FullyStatic', () => {
      const result = analyzeSSR(`
        export function Banner({ title }: { title: string }) {
          return <div className="banner"><h1>{title}</h1></div>;
        }
      `);
      const comp = compByName(result, 'Banner');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('FullyStatic');
      expect(comp!.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('classifies simple list rendering as FullyStatic', () => {
      const result = analyzeSSR(`
        export function ItemList({ items }: { items: string[] }) {
          return (
            <ul>
              {items.map(item => <li key={item}>{item}</li>)}
            </ul>
          );
        }
      `);
      const comp = compByName(result, 'ItemList');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('FullyStatic');
    });
  });

  describe('SSRSafe classification', () => {
    it('classifies component with useState as SSRSafe', () => {
      const result = analyzeSSR(`
        import { useState } from 'react';
        export function Counter() {
          const [count, setCount] = useState(0);
          return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
        }
      `);
      const comp = compByName(result, 'Counter');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hooks).toContain('useState');
    });

    it('classifies component with useEffect (browser API inside) as SSRSafe', () => {
      const result = analyzeSSR(`
        import { useState, useEffect } from 'react';
        export function TitleChanger() {
          const [title, setTitle] = useState('');
          useEffect(() => { document.title = title; }, [title]);
          return <input value={title} onChange={e => setTitle(e.target.value)} />;
        }
      `);
      const comp = compByName(result, 'TitleChanger');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.renderPathBrowserAPIs).toHaveLength(0);
    });

    it('classifies component with guarded browser access as SSRSafe', () => {
      const result = analyzeSSR(`
        export function SafeStorage() {
          let stored = '';
          if (typeof window !== 'undefined') {
            stored = localStorage.getItem('key') || '';
          }
          return <div>{stored}</div>;
        }
      `);
      const comp = compByName(result, 'SafeStorage');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
    });

    it('classifies component with event handler browser APIs as SSRSafe', () => {
      const result = analyzeSSR(`
        export function ScrollBtn() {
          const handleClick = () => {
            window.scrollTo(0, 0);
          };
          return <button onClick={handleClick}>Top</button>;
        }
      `);
      const comp = compByName(result, 'ScrollBtn');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
    });
  });

  describe('ClientOnly classification', () => {
    it('classifies component with window.innerWidth in render as ClientOnly', () => {
      const result = analyzeSSR(`
        export function WindowWidth() {
          const width = window.innerWidth;
          return <span>{width}</span>;
        }
      `);
      const comp = compByName(result, 'WindowWidth');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('ClientOnly');
      expect(comp!.renderPathBrowserAPIs.length).toBeGreaterThan(0);
    });

    it('classifies component using document.getElementById in render as ClientOnly', () => {
      const result = analyzeSSR(`
        export function DomQuery() {
          const el = document.getElementById('root');
          return <div>{el?.textContent}</div>;
        }
      `);
      const comp = compByName(result, 'DomQuery');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('ClientOnly');
    });

    it('classifies component with navigator access as ClientOnly', () => {
      const result = analyzeSSR(`
        export function UserAgent() {
          const ua = navigator.userAgent;
          return <pre>{ua}</pre>;
        }
      `);
      const comp = compByName(result, 'UserAgent');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('ClientOnly');
    });
  });

  describe('top-level browser access', () => {
    it('detects module-level browser API access', () => {
      const result = analyzeSSR(`
        const width = window.innerWidth;
        export function Display() {
          return <div>Width: {width}</div>;
        }
      `);
      expect(result.hasTopLevelBrowserAccess).toBe(true);
      expect(result.topLevelBrowserAPIs).toContain('window');
    });

    it('marks all components as ClientOnly when top-level browser access exists', () => {
      const result = analyzeSSR(`
        document.title = 'App';
        export function Header() {
          return <header>Hello</header>;
        }
        export function Footer() {
          return <footer>Bye</footer>;
        }
      `);
      expect(result.hasTopLevelBrowserAccess).toBe(true);
      for (const comp of result.components) {
        expect(comp.classification).toBe('ClientOnly');
      }
    });
  });

  describe('typeof window guard detection', () => {
    it('detects standard typeof window !== undefined guard', () => {
      const result = analyzeSSR(`
        export function GuardedComp() {
          let val = 'default';
          if (typeof window !== 'undefined') {
            val = localStorage.getItem('x') || 'default';
          }
          return <div>{val}</div>;
        }
      `);
      const comp = compByName(result, 'GuardedComp');
      expect(comp!.hasWindowGuards).toBe(true);
      expect(comp!.classification).toBe('SSRSafe');
    });

    it('detects inverted typeof window === undefined guard with explicit else', () => {
      const result = analyzeSSR(`
        export function InvertedGuard() {
          if (typeof window === 'undefined') {
            return <div>Server</div>;
          } else {
            return <div>{localStorage.getItem('key')}</div>;
          }
        }
      `);
      const comp = compByName(result, 'InvertedGuard');
      expect(comp!.hasWindowGuards).toBe(true);
      // The else branch is the guarded browser code
      expect(comp!.classification).toBe('SSRSafe');
    });

    it('detects short-circuit typeof window guard', () => {
      const result = analyzeSSR(`
        export function ShortCircuit() {
          const val = typeof window !== 'undefined' && localStorage.getItem('key');
          return <div>{val || 'none'}</div>;
        }
      `);
      const comp = compByName(result, 'ShortCircuit');
      expect(comp!.hasWindowGuards).toBe(true);
    });
  });

  describe('early return guard detection (mini-CFG)', () => {
    it('classifies component with early return server guard as SSRSafe', () => {
      // if (typeof window === 'undefined') return <fallback>
      // Code after the return is browser-only → guarded
      const result = analyzeSSR(`
        export function EarlyReturnGuard() {
          if (typeof window === 'undefined') {
            return <div>Server fallback</div>;
          }
          const width = window.innerWidth;
          return <span>Width: {width}</span>;
        }
      `);
      const comp = compByName(result, 'EarlyReturnGuard');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
      expect(comp!.renderPathBrowserAPIs).toHaveLength(0);
    });

    it('classifies component with early return server guard using bare return', () => {
      // Same pattern but with bare `return <div>...` instead of block
      const result = analyzeSSR(`
        export function BareReturnGuard() {
          if (typeof window === 'undefined') return <div>SSR</div>;
          const ua = navigator.userAgent;
          return <pre>{ua}</pre>;
        }
      `);
      const comp = compByName(result, 'BareReturnGuard');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
    });

    it('handles early return guard with multiple statements after guard', () => {
      const result = analyzeSSR(`
        export function MultiStatementAfterGuard() {
          if (typeof window === 'undefined') {
            return <div>Loading...</div>;
          }
          const width = window.innerWidth;
          const height = window.innerHeight;
          const el = document.getElementById('root');
          return <div>{width}x{height} {el?.className}</div>;
        }
      `);
      const comp = compByName(result, 'MultiStatementAfterGuard');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
    });

    it('does not apply early return guard when else branch exists', () => {
      // If there's an else branch, it's not an early return pattern
      const result = analyzeSSR(`
        export function NotEarlyReturn() {
          if (typeof window === 'undefined') {
            return <div>Server</div>;
          } else {
            const width = window.innerWidth;
            return <span>{width}</span>;
          }
        }
      `);
      const comp = compByName(result, 'NotEarlyReturn');
      expect(comp).toBeDefined();
      // This should still be SSRSafe because the else is already guarded
      // by the standard inverted guard detection (Pattern 1)
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
    });

    it('classifies component with client-check early return correctly', () => {
      // if (typeof window !== 'undefined') return <client-stuff>
      // Code after is SSR-only (safe)
      const result = analyzeSSR(`
        export function ClientReturnGuard() {
          if (typeof window !== 'undefined') {
            return <div>{window.innerWidth}</div>;
          }
          return <div>Server rendered content</div>;
        }
      `);
      const comp = compByName(result, 'ClientReturnGuard');
      expect(comp).toBeDefined();
      // The consequent (browser code) is already guarded by Pattern 1
      // Code after the if is server-only (safe)
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
    });

    it('handles early return guard with localStorage after guard', () => {
      const result = analyzeSSR(`
        export function StorageAfterGuard() {
          if (typeof window === 'undefined') {
            return <div>No storage on server</div>;
          }
          const val = localStorage.getItem('key') || 'default';
          return <div>{val}</div>;
        }
      `);
      const comp = compByName(result, 'StorageAfterGuard');
      expect(comp).toBeDefined();
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
    });
  });

  describe('fixture file: ssr-components.tsx', () => {
    const code = fixture('ssr-components.tsx');

    it('identifies all exported components', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const names = result.components.map((c) => c.name);
      expect(names).toContain('StaticBanner');
      expect(names).toContain('Counter');
      expect(names).toContain('WindowSize');
      expect(names).toContain('SafeComponent');
      expect(names).toContain('EffectComponent');
      expect(names).toContain('ScrollButton');
      expect(names).toContain('ComputedList');
    });

    it('classifies StaticBanner as FullyStatic', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const comp = compByName(result, 'StaticBanner');
      expect(comp!.classification).toBe('FullyStatic');
    });

    it('classifies Counter as SSRSafe', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const comp = compByName(result, 'Counter');
      expect(comp!.classification).toBe('SSRSafe');
    });

    it('classifies WindowSize as ClientOnly', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const comp = compByName(result, 'WindowSize');
      expect(comp!.classification).toBe('ClientOnly');
    });

    it('classifies SafeComponent as SSRSafe (guarded)', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const comp = compByName(result, 'SafeComponent');
      expect(comp!.classification).toBe('SSRSafe');
      expect(comp!.hasWindowGuards).toBe(true);
    });

    it('classifies EffectComponent as SSRSafe (browser API in useEffect)', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const comp = compByName(result, 'EffectComponent');
      expect(comp!.classification).toBe('SSRSafe');
    });

    it('classifies ScrollButton as SSRSafe (browser API in handler)', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const comp = compByName(result, 'ScrollButton');
      expect(comp!.classification).toBe('SSRSafe');
    });

    it('classifies ComputedList as SSRSafe (has useMemo)', () => {
      const result = analyzeSSR(code, 'ssr-components.tsx');
      const comp = compByName(result, 'ComputedList');
      // Has useMemo hook, so not FullyStatic, but render path is clean
      expect(comp!.classification).toBe('SSRSafe');
    });
  });

  describe('classifyModuleWithContext', () => {
    it('returns same segments as classifyModule', () => {
      const code = fixture('event-handler.tsx');
      const parsed = parseModule(code, 'event-handler.tsx');
      const context = classifyModuleWithContext(parsed, code);
      expect(context.segments.length).toBeGreaterThan(0);
      // Should have taint and hook context maps
      expect(context.taintResults).toBeInstanceOf(Map);
      expect(context.hookContexts).toBeInstanceOf(Map);
      expect(context.eventHandlerContexts).toBeInstanceOf(Map);
    });

    it('exposes taint results for all functions', () => {
      const code = fixture('event-handler.tsx');
      const parsed = parseModule(code, 'event-handler.tsx');
      const context = classifyModuleWithContext(parsed, code);
      expect(context.taintResults.size).toBe(parsed.functions.length);
    });
  });
});
