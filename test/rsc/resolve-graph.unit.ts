import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { resolveImport, loadPathsMatcher } from '../../src/rsc/resolve-graph.js';

const here = dirname(fileURLToPath(import.meta.url));

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

describe('resolveImport with tsconfig aliases', () => {
  const projDir = join(here, '..', 'fixtures', 'rsc', 'alias-proj');
  const matcher = loadPathsMatcher(projDir);

  it('loads a non-null matcher from the fixture tsconfig', () => {
    // Guard: a silent null would make the alias assertion below vacuously pass.
    expect(matcher).not.toBeNull();
  });

  it('resolves @/* aliases to src/* via createPathsMatcher', () => {
    const fooPath = join(projDir, 'src', 'components', 'Foo.tsx');
    const fileSet = new Set([fooPath, join(projDir, 'src', 'x', 'Bar.tsx')]);
    const resolved = resolveImport(
      '@/components/Foo',
      join(projDir, 'src', 'x', 'Bar.tsx'),
      fileSet,
      matcher,
    );
    expect(resolved).toBe(fooPath);
  });

  it('returns null for a bare module even with a matcher', () => {
    expect(
      resolveImport('react', join(projDir, 'src', 'x', 'Bar.tsx'), new Set(), matcher),
    ).toBeNull();
  });

  it('still resolves relatives when a matcher is provided', () => {
    const set = new Set([join(projDir, 'src', 'x', 'Foo.tsx')]);
    expect(
      resolveImport('./Foo', join(projDir, 'src', 'x', 'Bar.tsx'), set, matcher),
    ).toBe(join(projDir, 'src', 'x', 'Foo.tsx'));
  });
});
