import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { analyzeModule } from '../src/analyzer.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

describe('extraction engine', () => {
  describe('event-handler.tsx (primary extraction target)', () => {
    const getResult = () => analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');

    it('extracts event handlers to a grouped chunk module', () => {
      const result = getResult();
      expect(result.hasExtractions).toBe(true);
      expect(result.clientCode).toBeDefined();
      expect(result.chunkModules).toBeDefined();
      // Grouped: one module per source file containing all handlers
      expect(result.chunkModules!.length).toBe(1);
      expect(result.chunkModules![0].id).toMatch(/^grp_/);
      // Individual segment IDs tracked separately
      expect(result.extractedSegmentIds).toBeDefined();
      expect(result.extractedSegmentIds!.length).toBeGreaterThanOrEqual(3);
    });

    it('client code includes __phantom_lazy import', () => {
      const result = getResult();
      expect(result.clientCode).toContain("import { __phantom_lazy } from 'phantom-build/runtime'");
    });

    it('client code replaces handlers with lazy stubs pointing to grouped module', () => {
      const result = getResult();
      const groupId = result.chunkModules![0].id;
      // All stubs point to the same grouped module
      expect(result.clientCode).toContain(`import('phantom:${groupId}.js')`);
      // Each segment ID still appears as the second arg to __phantom_lazy
      for (const segId of result.extractedSegmentIds!) {
        expect(result.clientCode).toContain(`'${segId}'`);
      }
    });

    it('grouped chunk module exports functions with handler logic', () => {
      const result = getResult();
      const groupedCode = result.chunkModules![0].code;
      // Multiple exported functions in a single module
      const exportCount = (groupedCode.match(/export function/g) || []).length;
      expect(exportCount).toBeGreaterThanOrEqual(3);
      // At least one handler should have window/document/localStorage references
      const hasBrowserAPIs =
        groupedCode.includes('window') ||
        groupedCode.includes('document') ||
        groupedCode.includes('localStorage');
      expect(hasBrowserAPIs).toBe(true);
    });

    it('client code preserves JSX', () => {
      const result = getResult();
      expect(result.clientCode).toContain('<div');
      expect(result.clientCode).toContain('<input');
      expect(result.clientCode).toContain('<button');
    });

    it('client code preserves import declarations', () => {
      const result = getResult();
      expect(result.clientCode).toContain("from 'react'");
    });
  });

  describe('pure-memo.tsx (NO extraction — useMemo stays in bundle)', () => {
    it('no extractions for pure computation', () => {
      const result = analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');
      expect(result.hasExtractions).toBe(false);
      expect(result.clientCode).toBeUndefined();
      expect(result.chunkModules).toBeUndefined();
    });
  });

  describe('mixed.tsx', () => {
    const getResult = () => analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');

    it('extracts handleSubmit into grouped chunk module', () => {
      const result = getResult();
      expect(result.hasExtractions).toBe(true);
      expect(result.chunkModules).toBeDefined();
      // One grouped module per source file
      expect(result.chunkModules!.length).toBe(1);
      expect(result.chunkModules![0].id).toMatch(/^grp_/);
      expect(result.extractedSegmentIds!.length).toBeGreaterThanOrEqual(1);
    });

    it('chunk modules do NOT contain useMemo computation', () => {
      const result = getResult();
      const allChunkCode = result.chunkModules!.map(m => m.code).join('\n');
      // useMemo callbacks stay in the main bundle
      expect(allChunkCode).not.toContain('reduce');
      expect(allChunkCode).not.toContain('localeCompare');
    });

    it('chunk module contains form handling logic', () => {
      const result = getResult();
      const allChunkCode = result.chunkModules!.map(m => m.code).join('\n');
      expect(allChunkCode).toContain('preventDefault');
      expect(allChunkCode).toContain('FormData');
    });

    it('client code preserves useEffect and useMemo bodies', () => {
      const result = getResult();
      // useEffect stays in main bundle (ClientInteractive, not EventHandler)
      expect(result.clientCode).toContain('document.title');
      // useMemo stays in main bundle (PureComputation, not EventHandler)
      expect(result.clientCode).toContain('reduce');
    });

    it('respects confidence threshold', () => {
      const lowThreshold = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx', {
        confidenceThreshold: 0.5,
      });
      const highThreshold = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx', {
        confidenceThreshold: 0.95,
      });

      // Low threshold extracts more segments; high threshold may extract none
      expect(lowThreshold.extractedSegmentIds?.length ?? 0).toBeGreaterThanOrEqual(
        highThreshold.extractedSegmentIds?.length ?? 0,
      );
    });
  });

  describe('synchronous prelude', () => {
    it('mixed.tsx handleSubmit stub has preventDefault before __phantom_lazy', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');
      expect(result.clientCode).toBeDefined();
      // The stub must call e.preventDefault() synchronously
      expect(result.clientCode).toContain('preventDefault');
      // And it must appear BEFORE __phantom_lazy in the client code
      const clientCode = result.clientCode!;
      const preventIdx = clientCode.indexOf('preventDefault');
      const lazyIdx = clientCode.indexOf('__phantom_lazy');
      // The import statement has __phantom_lazy first, so find the lazy call AFTER preventDefault
      const lazyAfterPrevent = clientCode.indexOf('__phantom_lazy', preventIdx);
      expect(lazyAfterPrevent).toBeGreaterThan(preventIdx);
    });

    it('mixed.tsx handleSubmit stub has persist?.() call', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');
      expect(result.clientCode).toContain('persist');
    });

    it('event-handler.tsx handleClick does NOT get preventDefault in stub', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');
      // handleClick does not call preventDefault, so the stub should NOT have it
      // The chunk module WILL have window.location.href but NOT preventDefault
      const clientCode = result.clientCode!;
      // Count occurrences of preventDefault — should only appear in import/chunk, not in stubs
      // Actually, event-handler.tsx has no preventDefault at all
      expect(clientCode).not.toContain('preventDefault');
    });
  });

  describe('import rewriting', () => {
    it('relative imports in chunks are rewritten to absolute paths', () => {
      const code = `
import React from 'react';
import { validate } from './utils';
function App() {
  const handler = (e) => { validate(e.target.value); window.alert('done'); };
  return <button onClick={handler}>Go</button>;
}
      `;
      const result = analyzeModule(code, '/project/src/components/App.tsx');
      expect(result.hasExtractions).toBe(true);
      const allChunkCode = result.chunkModules!.map(m => m.code).join('\n');
      // Relative path should be rewritten to absolute
      expect(allChunkCode).toContain('/project/src/components/utils');
      // Should NOT contain the original relative path
      expect(allChunkCode).not.toContain("'./utils'");
    });

    it('bare specifiers are preserved unchanged', () => {
      const code = `
import React from 'react';
import { validate } from './utils';
function App() {
  const handler = (e) => { validate(e.target.value); window.alert('done'); };
  return <button onClick={handler}>Go</button>;
}
      `;
      const result = analyzeModule(code, '/project/src/components/App.tsx');
      // React import in the chunk (if used) stays as 'react'
      // The client code should keep 'react' as-is
      expect(result.clientCode).toContain("from 'react'");
    });
  });

  describe('FunctionExpression handling', () => {
    it('FunctionExpression event handler produces valid stub', () => {
      const code = `
import React from 'react';
function App() {
  const handler = function(e) { window.alert(e.target.value); };
  return <button onClick={handler}>Go</button>;
}
      `;
      const result = analyzeModule(code, 'func-expr.tsx');
      expect(result.hasExtractions).toBe(true);
      expect(result.clientCode).toContain('__phantom_lazy');

      // Client code must be parseable TSX
      const parsed = parseSync('client.tsx', result.clientCode!, {
        lang: 'tsx',
        sourceType: 'module',
      });
      expect(parsed.errors.length).toBe(0);
    });
  });

  describe('hasExtractions semantics', () => {
    it('hasExtractions is false when confidence threshold filters out all candidates', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx', {
        confidenceThreshold: 0.99,
      });
      // handleSubmit has confidence 0.9, below 0.99 threshold
      expect(result.hasExtractions).toBe(false);
      expect(result.clientCode).toBeUndefined();
      expect(result.chunkModules).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns no extraction for client-only module (no event handler JSX)', () => {
      const code = `
        import { useEffect } from 'react';
        function App() {
          useEffect(() => {
            document.title = 'Hello';
          }, []);
          return null;
        }
      `;
      const result = analyzeModule(code, 'client-only.tsx');
      expect(result.clientCode).toBeUndefined();
      expect(result.chunkModules).toBeUndefined();
    });

    it('returns no extraction for pure-only module', () => {
      const code = `
function formatPrice(price) {
  return '$' + price.toFixed(2);
}
      `;
      const result = analyzeModule(code, 'helper.ts');
      // Pure helpers are PureComputation, not EventHandler — no extraction
      expect(result.hasExtractions).toBe(false);
      expect(result.clientCode).toBeUndefined();
      expect(result.chunkModules).toBeUndefined();
    });

    it('extracts inline event handlers from JSX', () => {
      const code = `
import React from 'react';
function App() {
  return <button onClick={() => { window.alert('clicked'); }}>Click</button>;
}
      `;
      const result = analyzeModule(code, 'inline-handler.tsx');
      expect(result.hasExtractions).toBe(true);
      expect(result.chunkModules!.length).toBeGreaterThanOrEqual(1);
      expect(result.clientCode).toContain('__phantom_lazy');
    });

    it('no-extraction module returns undefined clientCode', () => {
      const code = `
        function touchesDOM() { window.scrollTo(0, 0); }
        export default touchesDOM;
      `;
      const result = analyzeModule(code, 'no-extract.ts');
      expect(result.clientCode).toBeUndefined();
      expect(result.chunkModules).toBeUndefined();
    });

    it('segment IDs match between client lazy calls and grouped chunk exports', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');
      const groupedCode = result.chunkModules![0].code;

      for (const segId of result.extractedSegmentIds!) {
        // Segment ID appears in client code as lazy argument
        expect(result.clientCode).toContain(`'${segId}'`);
        // Segment ID appears in grouped module as exported function name
        expect(groupedCode).toContain(segId);
      }
    });
  });

  describe('round-trip correctness', () => {
    it('chunk modules are parseable JavaScript', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');

      for (const mod of result.chunkModules!) {
        const parsed = parseSync('chunk.js', mod.code, {
          lang: 'js',
          sourceType: 'module',
        });
        expect(parsed.errors.length).toBe(0);
      }
    });

    it('client code is parseable TSX', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');

      const parsed = parseSync('client.tsx', result.clientCode!, {
        lang: 'tsx',
        sourceType: 'module',
      });
      expect(parsed.errors.length).toBe(0);
    });

    it('mixed.tsx chunk modules are all parseable', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');
      if (!result.chunkModules) return;

      for (const mod of result.chunkModules) {
        const parsed = parseSync('chunk.js', mod.code, {
          lang: 'js',
          sourceType: 'module',
        });
        expect(parsed.errors.length).toBe(0);
      }
    });

    it('mixed.tsx client code is parseable TSX', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');
      if (!result.clientCode) return;

      const parsed = parseSync('client.tsx', result.clientCode, {
        lang: 'tsx',
        sourceType: 'module',
      });
      expect(parsed.errors.length).toBe(0);
    });
  });

  describe('source maps', () => {
    it('client code has a valid source map', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');
      expect(result.clientMap).toBeDefined();
      expect(result.clientMap!.version).toBe(3);
      expect(result.clientMap!.mappings.length).toBeGreaterThan(0);
      expect(result.clientMap!.sources).toContain('event-handler.tsx');
    });

    it('grouped chunk module has valid source map', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');
      expect(result.chunkModules!.length).toBe(1);

      const mod = result.chunkModules![0];
      expect(mod.map).toBeDefined();
      expect(mod.map.version).toBe(3);
      expect(mod.map.mappings.length).toBeGreaterThan(0);
      expect(mod.map.sources).toContain('event-handler.tsx');
    });

    it('source maps include original source content', () => {
      const code = fixture('mixed.tsx');
      const result = analyzeModule(code, 'mixed.tsx');
      expect(result.clientMap).toBeDefined();
      expect(result.clientMap!.sourcesContent).toBeDefined();
      expect(result.clientMap!.sourcesContent.length).toBeGreaterThan(0);
      expect(result.clientMap!.sourcesContent[0]).toBe(code);
    });

    it('no source maps when no extractions occur', () => {
      const result = analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');
      expect(result.hasExtractions).toBe(false);
      expect(result.clientMap).toBeUndefined();
    });
  });

  describe('production readiness', () => {
    it('segment IDs are deterministic across file paths (content-addressable)', () => {
      const code = `
import React from 'react';
function App() {
  const handler = () => { window.alert('clicked'); };
  return <button onClick={handler}>Go</button>;
}
      `;
      const resultA = analyzeModule(code, '/home/user/project/App.tsx');
      const resultB = analyzeModule(code, '/ci/build/workspace/App.tsx');
      expect(resultA.extractedSegmentIds!.length).toBe(1);
      expect(resultB.extractedSegmentIds!.length).toBe(1);
      // Same code → same segment ID, regardless of file path
      expect(resultA.extractedSegmentIds![0]).toBe(resultB.extractedSegmentIds![0]);
    });

    it('arrow function with prelude has expression:false in AST (block body)', () => {
      const code = `
import React from 'react';
function App() {
  const handler = (e) => { e.preventDefault(); window.alert('hi'); };
  return <button onClick={handler}>Go</button>;
}
      `;
      const result = analyzeModule(code, 'test.tsx');
      // Client code must be valid — if expression property were wrong, esrap could mangle it
      const parsed = parseSync('client.tsx', result.clientCode!, { lang: 'tsx', sourceType: 'module' });
      expect(parsed.errors.length).toBe(0);
      // Prelude must appear as a block body, not expression body
      expect(result.clientCode).toContain('e.preventDefault()');
      expect(result.clientCode).toContain('persist');
      expect(result.clientCode).toContain('__phantom_lazy');
    });

    it('arrow function without prelude has expression body (no braces)', () => {
      const code = `
import React from 'react';
function App() {
  const handler = () => { window.alert('clicked'); };
  return <button onClick={handler}>Go</button>;
}
      `;
      const result = analyzeModule(code, 'test.tsx');
      const parsed = parseSync('client.tsx', result.clientCode!, { lang: 'tsx', sourceType: 'module' });
      expect(parsed.errors.length).toBe(0);
      // Should be expression body: () => __phantom_lazy(...)
      // NOT block body: () => { __phantom_lazy(...); }
      expect(result.clientCode).toMatch(/=>\s*__phantom_lazy/);
    });

    it('client code contains import factory for Rollup code-splitting', () => {
      const code = `
import React from 'react';
function App() {
  const handler = () => { window.alert('clicked'); };
  return <button onClick={handler}>Go</button>;
}
      `;
      const result = analyzeModule(code, 'test.tsx');
      const groupId = result.chunkModules![0].id;
      // Must have import factory: () => import('phantom:grp_xxx.js')
      expect(result.clientCode).toContain(`import('phantom:${groupId}.js')`);
    });
  });
});
