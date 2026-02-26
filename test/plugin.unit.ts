import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { phantom, VIRTUAL_PREFIX, PUBLIC_PREFIX } from '../src/index.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a raw plugin instance with fresh state.
 * `phantom.raw` returns the UnpluginOptions object so we can call hooks directly.
 */
function createPlugin(opts = {}) {
  return phantom.raw(opts, { framework: 'vite' });
}

/** Minimal mock context for unplugin hooks that need `this` */
const mockContext = {
  addWatchFile: () => {},
  emitFile: () => {},
  getWatchFiles: () => [] as string[],
  parse: () => ({}) as any,
  error: () => {},
  warn: () => {},
} as any;

// ── Tests ───────────────────────────────────────────────────────────────

describe('phantom unplugin', () => {
  describe('transformInclude', () => {
    const plugin = createPlugin();

    it('includes .tsx files', () => {
      expect(plugin.transformInclude!('src/App.tsx')).toBe(true);
    });

    it('includes .ts files', () => {
      expect(plugin.transformInclude!('src/utils.ts')).toBe(true);
    });

    it('includes .jsx files', () => {
      expect(plugin.transformInclude!('src/Component.jsx')).toBe(true);
    });

    it('includes .js files', () => {
      expect(plugin.transformInclude!('src/helper.js')).toBe(true);
    });

    it('excludes node_modules', () => {
      expect(plugin.transformInclude!('node_modules/react/index.js')).toBe(false);
    });

    it('excludes .css files', () => {
      expect(plugin.transformInclude!('src/styles.css')).toBe(false);
    });

    it('excludes .json files', () => {
      expect(plugin.transformInclude!('package.json')).toBe(false);
    });
  });

  describe('transform', () => {
    it('returns null for client-only code (no extractions)', async () => {
      const plugin = createPlugin();
      const code = `
        import { useEffect } from 'react';
        function App() {
          useEffect(() => { document.title = 'Hello'; }, []);
          return null;
        }
      `;
      const result = await (plugin.transform as Function).call(mockContext, code, 'app.tsx');
      expect(result).toBeNull();
    });

    it('returns rewritten client code for extractable module (event handlers)', async () => {
      const plugin = createPlugin();
      const code = fixture('event-handler.tsx');
      const result = await (plugin.transform as Function).call(mockContext, code, 'event-handler.tsx');

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain('__phantom_lazy');
      // Source map is now a real map object (not null)
      expect(result.map).toBeDefined();
      expect(result.map.version).toBe(3);
      expect(result.map.mappings.length).toBeGreaterThan(0);
    });

    it('returns null for pure-only module (no event handlers)', async () => {
      const plugin = createPlugin();
      const code = fixture('pure-memo.tsx');
      const result = await (plugin.transform as Function).call(mockContext, code, 'pure-memo.tsx');
      // pure-memo.tsx has no event handlers, so no extraction
      expect(result).toBeNull();
    });

    it('client code does NOT contain extracted handler logic', async () => {
      const plugin = createPlugin();
      const code = fixture('event-handler.tsx');
      const result = await (plugin.transform as Function).call(mockContext, code, 'event-handler.tsx');

      // The handler bodies should be replaced with lazy stubs
      expect(result.code).toContain('__phantom_lazy');
      // Client should still have the component structure
      expect(result.code).toContain('InteractiveComponent');
    });
  });

  describe('resolveId', () => {
    const plugin = createPlugin();

    it('resolves phantom: prefixed IDs by adding \\0', async () => {
      const result = await (plugin.resolveId as Function).call(
        mockContext,
        'phantom:seg_abc123.chunk.js',
        undefined,
        { isEntry: false },
      );
      expect(result).toBe('\0phantom:seg_abc123.chunk.js');
    });

    it('passes through \\0phantom: prefixed IDs (already resolved)', async () => {
      const result = await (plugin.resolveId as Function).call(
        mockContext,
        '\0phantom:seg_abc123.chunk.js',
        undefined,
        { isEntry: false },
      );
      expect(result).toBe('\0phantom:seg_abc123.chunk.js');
    });

    it('returns null for non-phantom IDs', async () => {
      const result = await (plugin.resolveId as Function).call(
        mockContext,
        'react',
        undefined,
        { isEntry: false },
      );
      expect(result).toBeNull();
    });

    it('returns null for regular file paths', async () => {
      const result = await (plugin.resolveId as Function).call(
        mockContext,
        './utils.ts',
        'src/app.tsx',
        { isEntry: false },
      );
      expect(result).toBeNull();
    });
  });

  describe('load', () => {
    it('returns chunk code for known virtual module IDs', async () => {
      const plugin = createPlugin();
      // First, transform to populate chunkModuleMap
      const code = fixture('event-handler.tsx');
      const transformResult = await (plugin.transform as Function).call(
        mockContext,
        code,
        'event-handler.tsx',
      );
      expect(transformResult).not.toBeNull();

      // Extract the grouped module ID from the import factory in the lazy call
      // Pattern: import('phantom:grp_xxx.js')
      const lazyMatch = transformResult.code.match(/import\('phantom:(grp_[a-f0-9]+)\.js'\)/);
      expect(lazyMatch).not.toBeNull();
      const groupId = lazyMatch![1];

      // Load the virtual module
      const virtualId = `${VIRTUAL_PREFIX}${groupId}.js`;
      const loadResult = (plugin.load as Function).call(mockContext, virtualId);
      expect(loadResult).toBeDefined();
      expect(loadResult.code).toBeDefined();
      expect(loadResult.code).toContain('export function');
      expect(loadResult.map).toBeDefined();
      expect(loadResult.map.version).toBe(3);
    });

    it('returns undefined for unknown virtual IDs', () => {
      const plugin = createPlugin();
      const result = (plugin.load as Function).call(
        mockContext,
        `${VIRTUAL_PREFIX}nonexistent.chunk.js`,
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined for non-phantom IDs', () => {
      const plugin = createPlugin();
      const result = (plugin.load as Function).call(mockContext, './utils.ts');
      expect(result).toBeUndefined();
    });
  });

  describe('end-to-end flow', () => {
    it('transform → resolveId → load produces parseable grouped chunk modules', async () => {
      const plugin = createPlugin();
      const code = fixture('event-handler.tsx');

      // Step 1: Transform
      const transformResult = await (plugin.transform as Function).call(
        mockContext,
        code,
        'event-handler.tsx',
      );
      expect(transformResult).not.toBeNull();

      // Step 2: Extract grouped module IDs from import factories in client code
      const lazyCalls = [...transformResult.code.matchAll(/import\('phantom:(grp_[a-f0-9]+)\.js'\)/g)];
      expect(lazyCalls.length).toBeGreaterThan(0);

      // Deduplicate — all stubs in same file point to the same grouped module
      const groupIds = [...new Set(lazyCalls.map((m) => m[1]))];
      expect(groupIds.length).toBe(1);

      for (const groupId of groupIds) {
        // Step 3: Resolve the virtual module
        const publicId = `phantom:${groupId}.js`;
        const resolvedId = await (plugin.resolveId as Function).call(
          mockContext,
          publicId,
          'event-handler.tsx',
          { isEntry: false },
        );
        expect(resolvedId).toBe(`\0${publicId}`);

        // Step 4: Load the chunk module code
        const loadResult = (plugin.load as Function).call(mockContext, resolvedId);
        expect(loadResult).toBeDefined();
        expect(loadResult.code).toBeDefined();
        expect(loadResult.map).toBeDefined();

        // Step 5: Verify the chunk code is parseable JavaScript with multiple exports
        const parsed = parseSync('chunk.js', loadResult.code, {
          lang: 'js',
          sourceType: 'module',
        });
        expect(parsed.errors.length).toBe(0);
        expect(loadResult.code).toContain('export function');
      }
    });

    it('client code is parseable TSX', async () => {
      const plugin = createPlugin();
      const code = fixture('event-handler.tsx');
      const result = await (plugin.transform as Function).call(mockContext, code, 'event-handler.tsx');

      const parsed = parseSync('client.tsx', result.code, {
        lang: 'tsx',
        sourceType: 'module',
      });
      expect(parsed.errors.length).toBe(0);
    });

    it('mixed.tsx produces grouped chunk module via load', async () => {
      const plugin = createPlugin();
      const code = fixture('mixed.tsx');
      const result = await (plugin.transform as Function).call(mockContext, code, 'mixed.tsx');
      expect(result).not.toBeNull();

      const lazyCalls = [...result.code.matchAll(/import\('phantom:(grp_[a-f0-9]+)\.js'\)/g)];
      expect(lazyCalls.length).toBeGreaterThanOrEqual(1);

      const groupIds = [...new Set(lazyCalls.map((m) => m[1]))];
      let loadedCount = 0;
      for (const groupId of groupIds) {
        const virtualId = `${VIRTUAL_PREFIX}${groupId}.js`;
        const loadResult = (plugin.load as Function).call(mockContext, virtualId);
        if (loadResult) {
          loadedCount++;
          // Should be parseable
          const parsed = parseSync('chunk.js', loadResult.code, {
            lang: 'js',
            sourceType: 'module',
          });
          expect(parsed.errors.length).toBe(0);
        }
      }
      expect(loadedCount).toBeGreaterThanOrEqual(1);
    });

    it('pure-memo.tsx produces no chunk modules', async () => {
      const plugin = createPlugin();
      const code = fixture('pure-memo.tsx');
      const result = await (plugin.transform as Function).call(
        mockContext,
        code,
        'pure-memo.tsx',
      );
      // No event handlers → no extraction
      expect(result).toBeNull();
    });
  });

  describe('virtual module constants', () => {
    it('VIRTUAL_PREFIX starts with \\0', () => {
      expect(VIRTUAL_PREFIX).toBe('\0phantom:');
    });

    it('PUBLIC_PREFIX has no \\0', () => {
      expect(PUBLIC_PREFIX).toBe('phantom:');
    });
  });

  describe('production readiness', () => {
    it('buildStart clears state for watch mode (no stale chunks)', async () => {
      const plugin = createPlugin();

      // First build: transform a file to populate chunk state
      const code = fixture('event-handler.tsx');
      const result1 = await (plugin.transform as Function).call(mockContext, code, 'event-handler.tsx');
      expect(result1).not.toBeNull();

      // Extract the grouped module ID
      const match1 = result1.code.match(/import\('phantom:(grp_[a-f0-9]+)\.js'\)/);
      expect(match1).not.toBeNull();
      const groupId1 = match1![1];

      // Verify chunk is loadable (returns { code, map } object)
      const virtualId1 = `${VIRTUAL_PREFIX}${groupId1}.js`;
      const loaded = (plugin.load as Function).call(mockContext, virtualId1);
      expect(loaded).toBeDefined();
      expect(loaded.code).toContain('export function');

      // Simulate watch mode rebuild: buildStart should clear all state
      (plugin.buildStart as Function).call(mockContext);

      // After reset, the old chunk should no longer be loadable
      expect((plugin.load as Function).call(mockContext, virtualId1)).toBeUndefined();
    });

    it('re-transform cleans up stale chunks from previous version (HMR)', async () => {
      const plugin = createPlugin();

      // First transform: extract handlers from event-handler.tsx
      const code1 = fixture('event-handler.tsx');
      const result1 = await (plugin.transform as Function).call(mockContext, code1, '/src/App.tsx');
      expect(result1).not.toBeNull();

      // Collect grouped module ID from first transform
      const matches1 = [...result1.code.matchAll(/import\('phantom:(grp_[a-f0-9]+)\.js'\)/g)];
      const groupIds1 = [...new Set(matches1.map((m) => m[1]))];
      expect(groupIds1.length).toBe(1);

      const virtualId = `${VIRTUAL_PREFIX}${groupIds1[0]}.js`;
      const loaded1 = (plugin.load as Function).call(mockContext, virtualId);
      expect(loaded1).toBeDefined();
      expect(loaded1.code).toContain('export function');

      // Second transform: same file path, different code (produces different handler content)
      const code2 = `
import React from 'react';
function App() {
  const handler = () => { window.alert('new version'); };
  return <button onClick={handler}>New</button>;
}
      `;
      const result2 = await (plugin.transform as Function).call(mockContext, code2, '/src/App.tsx');
      expect(result2).not.toBeNull();

      // Group ID stays the same (same file path → same hash), but content is replaced
      const matches2 = [...result2.code.matchAll(/import\('phantom:(grp_[a-f0-9]+)\.js'\)/g)];
      const groupIds2 = [...new Set(matches2.map((m) => m[1]))];
      expect(groupIds2[0]).toBe(groupIds1[0]); // Same group ID

      // The loaded module should now contain the NEW handler code, not old
      const loaded2 = (plugin.load as Function).call(mockContext, virtualId);
      expect(loaded2).toBeDefined();
      expect(loaded2.code).toContain('new version');
    });

    it('transform gracefully handles syntax errors (returns null, does not crash)', async () => {
      const plugin = createPlugin();
      const badCode = 'const x = {;'; // syntax error
      const result = await (plugin.transform as Function).call(mockContext, badCode, 'bad.tsx');
      // Should return null (skip), not throw
      expect(result).toBeNull();
    });
  });

  describe('build summary', () => {
    it('prints summary with handler names and module counts', async () => {
      const plugin = createPlugin();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Transform a file with extractable handlers
      const code = fixture('event-handler.tsx');
      await (plugin.transform as Function).call(mockContext, code, '/project/src/event-handler.tsx');

      // Also transform a file with no extractions
      const pureCode = fixture('pure-memo.tsx');
      await (plugin.transform as Function).call(mockContext, pureCode, '/project/src/pure-memo.tsx');

      // Call buildEnd to trigger summary
      (plugin.buildEnd as Function).call(mockContext);

      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');

      expect(output).toContain('[phantom] Build complete');
      expect(output).toContain('Modules scanned: 2');
      expect(output).toContain('Modules with extractions: 1');
      expect(output).toContain('Handlers extracted: 3');
      expect(output).toContain('event-handler.tsx');
      expect(output).toContain('Manifest:');

      logSpy.mockRestore();
    });

    it('silent option suppresses build summary', async () => {
      const plugin = createPlugin({ silent: true });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const code = fixture('event-handler.tsx');
      await (plugin.transform as Function).call(mockContext, code, '/project/src/event-handler.tsx');
      (plugin.buildEnd as Function).call(mockContext);

      // log should NOT be called with phantom summary
      const phantomCalls = logSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('[phantom]'),
      );
      expect(phantomCalls.length).toBe(0);

      logSpy.mockRestore();
    });

    it('prints minimal summary when no handlers extracted', async () => {
      const plugin = createPlugin();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Transform only a pure module — no extractions
      const code = fixture('pure-memo.tsx');
      await (plugin.transform as Function).call(mockContext, code, '/project/src/pure-memo.tsx');
      (plugin.buildEnd as Function).call(mockContext);

      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('no handlers extracted');

      logSpy.mockRestore();
    });
  });

  describe('SSR mode', () => {
    it('transform returns null for all modules (no-op)', async () => {
      const plugin = createPlugin({ ssr: true });
      const code = fixture('event-handler.tsx');
      const result = await (plugin.transform as Function).call(
        mockContext, code, 'event-handler.tsx',
      );
      // SSR mode: original code passes through untouched
      expect(result).toBeNull();
    });

    it('transform returns null even for modules with lazy candidates', async () => {
      const plugin = createPlugin({ ssr: true });
      const code = `
import React from 'react';
import { PaymentForm } from './PaymentForm';

export default function CheckoutPage() {
  return (
    <div>
      <header>Header</header>
      <nav>Nav</nav>
      <PaymentForm />
    </div>
  );
}
      `;
      const result = await (plugin.transform as Function).call(
        mockContext, code, '/src/CheckoutPage.tsx',
      );
      expect(result).toBeNull();
    });

    it('buildEnd prints SSR notice and does not write manifest', () => {
      const plugin = createPlugin({ ssr: true });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      (plugin.buildEnd as Function).call(mockContext);

      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('SSR mode');
      expect(output).not.toContain('Manifest:');

      logSpy.mockRestore();
    });

    it('buildEnd respects silent option in SSR mode', () => {
      const plugin = createPlugin({ ssr: true, silent: true });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      (plugin.buildEnd as Function).call(mockContext);

      const phantomCalls = logSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('[phantom]'),
      );
      expect(phantomCalls.length).toBe(0);

      logSpy.mockRestore();
    });

    it('resolveId and load still work in SSR mode (no crash)', async () => {
      const plugin = createPlugin({ ssr: true });

      // resolveId should still resolve phantom: prefixed IDs
      const resolved = await (plugin.resolveId as Function).call(
        mockContext, 'phantom:seg_abc.chunk.js', undefined, { isEntry: false },
      );
      expect(resolved).toBe('\0phantom:seg_abc.chunk.js');

      // load returns undefined since no chunks were registered
      const loaded = (plugin.load as Function).call(
        mockContext, '\0phantom:seg_abc.chunk.js',
      );
      expect(loaded).toBeUndefined();
    });

    it('works alongside enableLazy: false without conflict', async () => {
      const plugin = createPlugin({ ssr: true, enableLazy: false });
      const code = fixture('event-handler.tsx');
      const result = await (plugin.transform as Function).call(
        mockContext, code, 'event-handler.tsx',
      );
      expect(result).toBeNull();
    });
  });

  describe('barrel file resolution', () => {
    it('resolves lazy candidates through barrel file re-exports', async () => {
      const plugin = createPlugin({ silent: true });

      // Step 1: Transform the barrel file first (establishes re-export mappings)
      const barrelCode = `
export { PaymentForm } from './PaymentForm';
export { AddressForm } from './AddressForm';
export type { FormProps } from './types';
      `;
      await (plugin.transform as Function).call(
        mockContext, barrelCode, '/project/src/components/index.ts',
      );

      // Step 2: Transform a route-level component that imports through the barrel.
      // Components at positions 0-1 are above fold and kept static, so we need
      // enough siblings to push our targets below fold (position >= 2).
      const pageCode = `
import React from 'react';
import { PaymentForm, AddressForm } from './components';

export default function CheckoutPage() {
  return (
    <div>
      <header>Header</header>
      <nav>Nav</nav>
      <PaymentForm />
      <AddressForm />
    </div>
  );
}
      `;
      const result = await (plugin.transform as Function).call(
        mockContext, pageCode, '/project/src/CheckoutPage.tsx',
      );

      // The lazy candidates should have been detected (below fold in route component)
      expect(result).not.toBeNull();
      // The output uses `lazy` imported from react, not `React.lazy`
      expect(result.code).toContain('lazy');
      expect(result.code).toContain('Suspense');

      // The dynamic import should target the resolved component modules
      // (resolved through the barrel), not the barrel file itself.
      // e.g., import('./components/PaymentForm') not import('./components')
      expect(result.code).toContain('./components/PaymentForm');
      expect(result.code).toContain('./components/AddressForm');
    });

    it('falls back gracefully when barrel file has not been transformed yet', async () => {
      const plugin = createPlugin({ silent: true });

      // Transform the consumer WITHOUT the barrel being processed first.
      // Needs enough siblings to push target below fold.
      const pageCode = `
import React from 'react';
import { PaymentForm } from './components';

export default function CheckoutPage() {
  return (
    <div>
      <header>Header</header>
      <nav>Nav</nav>
      <PaymentForm />
    </div>
  );
}
      `;
      // Should not throw — gracefully falls back to barrel file as source
      const result = await (plugin.transform as Function).call(
        mockContext, pageCode, '/project/src/CheckoutPage.tsx',
      );

      // Still produces lazy output (just using barrel as import source)
      expect(result).not.toBeNull();
      expect(result.code).toContain('lazy');
    });
  });
});
