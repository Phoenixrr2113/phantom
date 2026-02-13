import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { analyzeModule } from '../src/analyzer.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

describe('extraction engine', () => {
  describe('pure-memo.tsx', () => {
    const getResult = () => analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

    it('extracts useMemo callback to server module', () => {
      const result = getResult();
      expect(result.hasServerExtractions).toBe(true);
      expect(result.clientCode).toBeDefined();
      expect(result.serverModules).toBeDefined();
      expect(result.serverModules!.length).toBe(1);
    });

    it('ProductPage is NOT extracted (JSX component)', () => {
      const result = getResult();
      // Only the useMemo callback should be extracted, not the component
      expect(result.serverModules!.length).toBe(1);
      const allServerCode = result.serverModules!.map(m => m.code).join('\n');
      expect(allServerCode).not.toContain('ProductPage');
      // Client code should still have ProductPage as a full component
      expect(result.clientCode).toContain('ProductPage');
    });

    it('client code includes __phantom_rpc import', () => {
      const result = getResult();
      expect(result.clientCode).toContain("import { __phantom_rpc } from 'phantom-build/runtime'");
    });

    it('client code replaces useMemo callback with RPC call', () => {
      const result = getResult();
      const segId = result.serverModules![0].id;
      // The useMemo callback should be replaced with an RPC call passing `products`
      expect(result.clientCode).toContain(`__phantom_rpc('${segId}', products)`);
    });

    it('server module exports function with products parameter', () => {
      const result = getResult();
      const serverMod = result.serverModules![0];
      expect(serverMod.code).toContain('export function');
      expect(serverMod.code).toContain(serverMod.id);
      expect(serverMod.code).toContain('(products)');
    });

    it('server module contains original computation logic', () => {
      const result = getResult();
      const serverMod = result.serverModules![0];
      expect(serverMod.code).toContain('filter');
      expect(serverMod.code).toContain('inStock');
      expect(serverMod.code).toContain('sort');
      expect(serverMod.code).toContain('rating');
    });

    it('client code preserves JSX', () => {
      const result = getResult();
      expect(result.clientCode).toContain('<div>');
      expect(result.clientCode).toContain('<span');
      expect(result.clientCode).toContain('</div>');
    });

    it('client code preserves import declarations', () => {
      const result = getResult();
      expect(result.clientCode).toContain("from 'react'");
      expect(result.clientCode).toContain('useMemo');
    });
  });

  describe('mixed.tsx', () => {
    const getResult = () => analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');

    it('extracts useMemo callbacks and formatValue', () => {
      const result = getResult();
      expect(result.hasServerExtractions).toBe(true);
      // Two useMemo callbacks + formatValue = 3 server modules
      expect(result.serverModules!.length).toBe(3);
    });

    it('server modules do NOT contain client-side code', () => {
      const result = getResult();
      const allServerCode = result.serverModules!.map(m => m.code).join('\n');
      expect(allServerCode).not.toContain('document.title');
      expect(allServerCode).not.toContain('preventDefault');
      expect(allServerCode).not.toContain('FormData');
      expect(allServerCode).not.toContain('HTMLFormElement');
    });

    it('client code preserves useEffect and handleSubmit bodies', () => {
      const result = getResult();
      expect(result.clientCode).toContain('document.title');
      expect(result.clientCode).toContain('preventDefault');
    });

    it('formatValue server module has value parameter', () => {
      const result = getResult();
      const formatMod = result.serverModules!.find(m => m.code.includes('toFixed'));
      expect(formatMod).toBeDefined();
      expect(formatMod!.code).toContain('(value)');
    });

    it('formatValue client stub passes value through', () => {
      const result = getResult();
      const formatMod = result.serverModules!.find(m => m.code.includes('toFixed'));
      expect(result.clientCode).toContain(`__phantom_rpc('${formatMod!.id}', value)`);
    });

    it('respects confidence threshold', () => {
      const lowThreshold = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx', {
        confidenceThreshold: 0.5,
      });
      const highThreshold = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx', {
        confidenceThreshold: 0.95,
      });

      expect(lowThreshold.serverModules!.length).toBeGreaterThanOrEqual(
        highThreshold.serverModules?.length ?? 0,
      );
    });
  });

  describe('event-handler.tsx', () => {
    it('no extractions — all handlers are client-side', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');
      expect(result.hasServerExtractions).toBe(false);
      expect(result.clientCode).toBeUndefined();
      expect(result.serverModules).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns no extraction for client-only module', () => {
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
      expect(result.serverModules).toBeUndefined();
    });

    it('handles inline pure helper with parameters', () => {
      const code = `
function formatPrice(price) {
  return '$' + price.toFixed(2);
}
      `;
      const result = analyzeModule(code, 'helper.ts');
      expect(result.hasServerExtractions).toBe(true);
      expect(result.serverModules!.length).toBe(1);

      const serverMod = result.serverModules![0];
      expect(serverMod.code).toContain('toFixed');
      expect(serverMod.code).toContain('(price)');
    });

    it('preserves async functions', () => {
      const code = `
async function computeHash(data) {
  return data.split('').reduce((h, c) => h + c.charCodeAt(0), 0);
}
      `;
      const result = analyzeModule(code, 'async-helper.ts');
      expect(result.hasServerExtractions).toBe(true);

      const serverMod = result.serverModules![0];
      expect(serverMod.code).toContain('async function');
    });

    it('segment IDs match between client RPC calls and server exports', () => {
      const result = analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      for (const mod of result.serverModules!) {
        // Segment ID appears in client code as RPC argument
        expect(result.clientCode).toContain(`'${mod.id}'`);
        // Segment ID appears in server module as function name
        expect(mod.code).toContain(mod.id);
      }
    });

    it('no-extraction module returns undefined clientCode', () => {
      const code = `
        function touchesDOM() { window.scrollTo(0, 0); }
        export default touchesDOM;
      `;
      const result = analyzeModule(code, 'no-extract.ts');
      expect(result.clientCode).toBeUndefined();
      expect(result.serverModules).toBeUndefined();
    });
  });

  describe('round-trip correctness', () => {
    it('server modules are parseable JavaScript', () => {
      const result = analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      for (const mod of result.serverModules!) {
        // Parse with OXC — should not throw
        const parsed = parseSync('server.js', mod.code, {
          lang: 'js',
          sourceType: 'module',
        });
        expect(parsed.errors.length).toBe(0);
      }
    });

    it('client code is parseable TSX', () => {
      const result = analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      const parsed = parseSync('client.tsx', result.clientCode!, {
        lang: 'tsx',
        sourceType: 'module',
      });
      expect(parsed.errors.length).toBe(0);
    });

    it('mixed.tsx server modules are all parseable', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');

      for (const mod of result.serverModules!) {
        const parsed = parseSync('server.js', mod.code, {
          lang: 'js',
          sourceType: 'module',
        });
        expect(parsed.errors.length).toBe(0);
      }
    });

    it('mixed.tsx client code is parseable TSX', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');

      const parsed = parseSync('client.tsx', result.clientCode!, {
        lang: 'tsx',
        sourceType: 'module',
      });
      expect(parsed.errors.length).toBe(0);
    });
  });
});
