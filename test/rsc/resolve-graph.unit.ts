import { describe, it, expect } from 'vitest';
import { resolveImport } from '../../src/rsc/resolve-graph.js';

describe('resolveImport (relative specifiers)', () => {
  it('resolves a bare relative sibling to its .tsx file', () => {
    const set = new Set(['/app/Foo.tsx', '/app/Bar.tsx']);
    expect(resolveImport('./Foo', '/app/Bar.tsx', set)).toBe('/app/Foo.tsx');
  });

  it('prefers .tsx over .ts when both exist (extension order)', () => {
    const set = new Set(['/app/Foo.ts', '/app/Foo.tsx']);
    expect(resolveImport('./Foo', '/app/Bar.tsx', set)).toBe('/app/Foo.tsx');
  });

  it('resolves a parent-directory specifier (../shared/Util)', () => {
    const set = new Set(['/app/shared/Util.ts', '/app/pages/Bar.tsx']);
    expect(resolveImport('../shared/Util', '/app/pages/Bar.tsx', set)).toBe('/app/shared/Util.ts');
  });

  it('resolves a directory import to its index file', () => {
    const set = new Set(['/app/components/index.tsx', '/app/Bar.tsx']);
    expect(resolveImport('./components', '/app/Bar.tsx', set)).toBe('/app/components/index.tsx');
  });

  it('resolves an explicit-extension specifier as-is', () => {
    const set = new Set(['/app/Foo.tsx', '/app/Bar.tsx']);
    expect(resolveImport('./Foo.tsx', '/app/Bar.tsx', set)).toBe('/app/Foo.tsx');
  });

  it('returns null for a bare module specifier', () => {
    const set = new Set(['/app/Bar.tsx']);
    expect(resolveImport('react', '/app/Bar.tsx', set)).toBeNull();
  });

  it('returns null for a tsconfig alias specifier (not handled here)', () => {
    const set = new Set(['/app/components/Foo.tsx', '/app/Bar.tsx']);
    expect(resolveImport('@/components/Foo', '/app/Bar.tsx', set)).toBeNull();
  });

  it('returns null when no candidate exists in the file set', () => {
    const set = new Set(['/app/Bar.tsx']);
    expect(resolveImport('./Nope', '/app/Bar.tsx', set)).toBeNull();
  });
});
