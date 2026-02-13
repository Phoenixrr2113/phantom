import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseModule } from '../src/analyzer.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

describe('parseModule', () => {
  describe('pure-memo.tsx', () => {
    it('parses and produces function dependency info', () => {
      const result = parseModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      expect(result.path).toBe('pure-memo.tsx');
      expect(result.ast.type).toBe('Program');
      expect(result.functions.length).toBeGreaterThan(0);
    });

    it('extracts import information', () => {
      const result = parseModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      expect(result.imports).toEqual([
        {
          source: 'react',
          specifiers: expect.arrayContaining([
            expect.objectContaining({ local: 'React', kind: 'default' }),
            expect.objectContaining({ local: 'useMemo', kind: 'named' }),
          ]),
        },
      ]);
    });

    it('identifies the ProductPage function with correct dependencies', () => {
      const result = parseModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      const productPage = result.functions.find(f => f.name === 'ProductPage');
      expect(productPage).toBeDefined();
      expect(productPage!.locals).toContain('sorted');
      expect(productPage!.locals).toContain('products');
      expect(productPage!.imported).toContain('useMemo');
    });

    it('identifies the useMemo callback globals correctly', () => {
      const result = parseModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      // The useMemo callback captures `products` from parent scope
      // Its only "global" is Math (a safe pure builtin, not a browser API)
      const memoCallback = result.functions.find(
        f => f.name === '<anonymous>' && f.captured.includes('products')
      );
      expect(memoCallback).toBeDefined();
      // Math is unresolved (global) but NOT a browser API — classification
      // engine (Phase 3) will handle this distinction
      expect(memoCallback!.globals).toEqual(['Math']);
    });
  });

  describe('event-handler.tsx', () => {
    it('identifies event handlers with browser globals', () => {
      const result = parseModule(fixture('event-handler.tsx'), 'event-handler.tsx');

      // handleClick references `window`
      const withWindow = result.functions.filter(f => f.globals.includes('window'));
      expect(withWindow.length).toBeGreaterThan(0);

      // handleFocus references `document`
      const withDocument = result.functions.filter(f => f.globals.includes('document'));
      expect(withDocument.length).toBeGreaterThan(0);

      // handleScroll references `window` and `localStorage`
      const withStorage = result.functions.filter(f => f.globals.includes('localStorage'));
      expect(withStorage.length).toBeGreaterThan(0);
    });
  });

  describe('mixed.tsx', () => {
    it('distinguishes pure functions from those with browser globals', () => {
      const result = parseModule(fixture('mixed.tsx'), 'mixed.tsx');

      const browserGlobals = ['window', 'document', 'localStorage', 'console'];

      // Some functions should have NO browser globals (pure computation)
      const pureFunctions = result.functions.filter(
        f => !f.globals.some(g => browserGlobals.includes(g))
      );

      // Some functions should have browser globals (DOM/browser APIs)
      const impureFunctions = result.functions.filter(
        f => f.globals.some(g => browserGlobals.includes(g))
      );

      // We should find both kinds
      expect(pureFunctions.length).toBeGreaterThan(0);
      expect(impureFunctions.length).toBeGreaterThan(0);
    });

    it('extracts all imports from react', () => {
      const result = parseModule(fixture('mixed.tsx'), 'mixed.tsx');
      const reactImport = result.imports.find(i => i.source === 'react');

      expect(reactImport).toBeDefined();
      expect(reactImport!.specifiers.map(s => s.local)).toEqual(
        expect.arrayContaining(['React', 'useMemo', 'useCallback', 'useEffect', 'useState'])
      );
    });
  });

  describe('edge cases', () => {
    it('handles empty file', () => {
      const result = parseModule('', 'empty.ts');
      expect(result.functions).toEqual([]);
      expect(result.imports).toEqual([]);
    });

    it('handles file with no functions', () => {
      const result = parseModule('const x = 1;\nexport default x;', 'const.ts');
      expect(result.functions).toEqual([]);
    });

    it('handles plain JS file', () => {
      const code = `
        function add(a, b) { return a + b; }
        const result = add(1, 2);
      `;
      const result = parseModule(code, 'math.js');
      expect(result.functions.length).toBe(1);
      expect(result.functions[0].name).toBe('add');
      expect(result.functions[0].globals).toEqual([]);
    });
  });
});
