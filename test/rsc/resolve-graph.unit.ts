import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseModule } from '../../src/analyzer.js';
import {
  resolveImport,
  loadPathsMatcher,
  resolveEdge,
  buildComponentGraph,
} from '../../src/rsc/resolve-graph.js';

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

describe('resolveEdge — one-hop barrels', () => {
  it('follows an index.ts re-export to the defining file', () => {
    const barrel = parseModule(`export { Foo } from './Foo';`, '/app/components/index.ts');
    expect(barrel.reExports.length).toBeGreaterThan(0); // sanity: extractor populated it
    const reExportsByFile = new Map([['/app/components/index.ts', barrel.reExports]]);
    const fileSet = new Set(['/app/components/index.ts', '/app/components/Foo.tsx', '/app/Bar.tsx']);
    expect(resolveEdge('./components', '/app/Bar.tsx', 'Foo', fileSet, reExportsByFile))
      .toBe('/app/components/Foo.tsx');
  });

  it('handles `export { default as X }` aliased re-exports', () => {
    const barrel = parseModule(`export { default as Foo } from './Foo';`, '/app/ui/index.ts');
    const reExportsByFile = new Map([['/app/ui/index.ts', barrel.reExports]]);
    const fileSet = new Set(['/app/ui/index.ts', '/app/ui/Foo.tsx']);
    // fromFile must sit beside the `./ui` barrel dir so the specifier resolves
    // to /app/ui/index.ts before the `default as` hop runs.
    expect(resolveEdge('./ui', '/app/Bar.tsx', 'Foo', fileSet, reExportsByFile))
      .toBe('/app/ui/Foo.tsx');
  });

  it('falls back to the barrel file when the imported name is not re-exported (one hop only)', () => {
    const barrel = parseModule(`export { Other } from './Other';`, '/app/components/index.ts');
    const reExportsByFile = new Map([['/app/components/index.ts', barrel.reExports]]);
    const fileSet = new Set(['/app/components/index.ts', '/app/components/Other.tsx']);
    expect(resolveEdge('./components', '/app/Bar.tsx', 'Foo', fileSet, reExportsByFile))
      .toBe('/app/components/index.ts');
  });

  it('resolves a non-barrel direct import unchanged', () => {
    expect(resolveEdge('./Foo', '/app/Bar.tsx', 'Foo', new Set(['/app/Foo.tsx']), new Map()))
      .toBe('/app/Foo.tsx');
  });
});

describe('buildComponentGraph', () => {
  const graphDir = join(here, '..', 'fixtures', 'rsc', 'graph-basic');
  const abs = (p: string): string => join(graphDir, p);
  const graph = buildComponentGraph(graphDir);

  it('classifies every source file in the tree (App, Layout, index, Card, Sidebar)', () => {
    expect(graph.files.size).toBe(5);
  });

  it('marks App.tsx must-be-client (useState)', () => {
    expect(graph.files.get(abs('App.tsx'))!.fileVerdict).toBe('must-be-client');
  });

  it('marks Card.tsx server-eligible (pure props→JSX)', () => {
    expect(graph.files.get(abs('components/Card.tsx'))!.fileVerdict).toBe('server-eligible');
  });

  it('resolves the one-hop barrel edge Layout → components/Card.tsx', () => {
    // Layout imports { Card } from './components' (an index.ts barrel that
    // re-exports Card from './Card') — the edge must point at Card.tsx itself.
    expect(graph.files.get(abs('Layout.tsx'))!.imports).toContain(abs('components/Card.tsx'));
  });

  it('resolves App → Layout and excludes the external react import', () => {
    const appImports = graph.files.get(abs('App.tsx'))!.imports;
    expect(appImports).toContain(abs('Layout.tsx'));
    expect(appImports.some((i) => /react/.test(i))).toBe(false);
  });

  it('reports edgeResolution = 2/3 (App→Layout ✓, Layout→components ✓, Sidebar→Gone ✗; react excluded)', () => {
    // Internal module edges: App→'./Layout' (resolved), Layout→'./components'
    // (resolved), Sidebar→'./Gone' (unresolved, file absent). `react` is a bare
    // external import and is excluded from the metric entirely.
    expect(graph.edgeResolution).toBeCloseTo(2 / 3);
  });
});
