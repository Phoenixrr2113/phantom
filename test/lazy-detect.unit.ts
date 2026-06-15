import { describe, it, expect } from 'vitest';
import { print } from 'esrap';
import tsx from 'esrap/languages/tsx';
import type { Program } from 'estree';
import { parseModule, analyzeModule } from '../src/analyzer.js';
import { detectLazyCandidates, classifyModule } from '../src/classify/index.js';
import { applyLazyTransforms } from '../src/extract/lazy-transform.js';
import type { LazyCandidate, LazyCandidateResult } from '../src/types.js';

/** Re-export map shape consumed by detectLazyCandidates (barrel → exports). */
type ReExportMap = Map<string, Map<string, { source: string; importedName: string }>>;

/** Run the full heuristic lazy-detection pass on a source string. */
function detect(code: string, path = '/src/widgets/Panel.tsx'): LazyCandidateResult {
  const parsed = parseModule(code, path);
  const segments = classifyModule(parsed, code);
  return detectLazyCandidates(parsed, code, segments);
}

const names = (list: Array<{ localName: string }>): string[] => list.map((c) => c.localName);

describe('lazy detection — "used only as JSX" guard', () => {
  it('lazifies a component used purely as a JSX element', () => {
    // Control: Heavy appears only as <Heavy />, so converting it to
    // React.lazy is safe — it can only ever be rendered.
    const code = `
import { Heavy } from './Heavy';
export function Panel() {
  return <section><Heavy /></section>;
}
`;
    const result = detect(code);
    expect(names(result.lazy)).toContain('Heavy');
    expect(names(result.keepStatic)).not.toContain('Heavy');
  });

  it('keeps a component static when it is also referenced as a runtime value', () => {
    // Heavy is rendered as <Heavy /> AND read as a value (Heavy.displayName).
    // React.lazy returns an opaque LazyExoticComponent — reading a property
    // off it at runtime breaks. Phantom must not lazify this binding.
    const code = `
import { Heavy } from './Heavy';
export function Panel() {
  const label = Heavy.displayName ?? 'Heavy';
  return <section>{label}<Heavy /></section>;
}
`;
    const result = detect(code);
    expect(names(result.lazy)).not.toContain('Heavy');
    expect(names(result.keepStatic)).toContain('Heavy');
    const kept = result.keepStatic.find((c) => c.localName === 'Heavy');
    expect(kept?.reason).toMatch(/value/i);
  });

  it('still lazifies when the only extra reference is a TS type position (typeof X)', () => {
    // `typeof Heavy` in a type is erased at build time — it cannot break a
    // lazy component at runtime, so the guard must not keep Heavy static.
    const code = `
import { Heavy } from './Heavy';
type HeavyType = typeof Heavy;
export function Panel(props: { ctor?: HeavyType }) {
  return <section><Heavy /></section>;
}
`;
    const result = detect(code);
    expect(names(result.lazy)).toContain('Heavy');
    expect(names(result.keepStatic)).not.toContain('Heavy');
  });

  it('keeps a component static when used as a value through a TS cast (Foo as X)', () => {
    // `Heavy as unknown` is a runtime value expression (only the type is
    // erased), so the guard must still treat it as a value usage.
    const code = `
import { Heavy } from './Heavy';
export function Panel() {
  const ctor = Heavy as unknown;
  return <section>{String(!!ctor)}<Heavy /></section>;
}
`;
    const result = detect(code);
    expect(names(result.lazy)).not.toContain('Heavy');
    expect(names(result.keepStatic)).toContain('Heavy');
  });

  it('keeps a component static when passed as a value to another element (component={X})', () => {
    // Classic break: <Route component={Heavy} /> passes Heavy as a value.
    // phantom only wraps the <Heavy /> JSX site it finds, leaving the
    // component={Heavy} usage pointing at a lazy object outside any boundary.
    const code = `
import { Heavy } from './Heavy';
export function Panel({ route }) {
  return (
    <section>
      <Heavy />
      <route.Route component={Heavy} />
    </section>
  );
}
`;
    const result = detect(code);
    expect(names(result.lazy)).not.toContain('Heavy');
    expect(names(result.keepStatic)).toContain('Heavy');
  });
});

// ── Emitted-code shape per export kind ────────────────────────────────────
// Characterization tests: they lock in CURRENT behavior for branches that
// previously had no coverage (default import, aliased import, barrel rename).
// They are expected to pass on first run — that is their purpose as
// regression guards, not test-first drivers.

/** Full client code emitted by the pipeline for a lazy-only module. */
function clientCode(code: string, path = '/src/widgets/Panel.tsx'): string {
  return analyzeModule(code, path).clientCode ?? '';
}

/** Detect with a barrel re-export map (the path analyzeModule doesn't wire). */
function detectWithBarrel(code: string, path: string, reExportMap: ReExportMap): LazyCandidateResult {
  const parsed = parseModule(code, path);
  const segments = classifyModule(parsed, code);
  return detectLazyCandidates(parsed, code, segments, undefined, reExportMap);
}

/** Detect (optionally through a barrel) then emit the transformed code. */
function emit(code: string, path: string, reExportMap?: ReExportMap): string {
  const parsed = parseModule(code, path);
  const segments = classifyModule(parsed, code);
  const result = detectLazyCandidates(parsed, code, segments, undefined, reExportMap);
  const ast = structuredClone(parsed.ast) as Program;
  applyLazyTransforms(ast, result.lazy);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- esrap visitors expect TSESTree nodes; OXC produces compatible estree
  return print(ast as any, tsx() as any).code;
}

describe('lazy transform — emitted code per export kind', () => {
  it('named import → shim reads the named export off the module', () => {
    const code = `
import { PaymentForm } from './PaymentForm';
export function Panel() {
  return <section><PaymentForm /></section>;
}
`;
    const out = clientCode(code);
    expect(out).toMatch(/import\('\.\/PaymentForm'\)\s*\.then\(/);
    expect(out).toMatch(/default:\s*m\.PaymentForm/);
  });

  it('default import → React.lazy with no .then shim', () => {
    const code = `
import Heavy from './Heavy';
export function Panel() {
  return <section><Heavy /></section>;
}
`;
    const out = clientCode(code);
    expect(out).toMatch(/lazy\(\(\)\s*=>\s*import\('\.\/Heavy'\)\)/);
    expect(out).not.toContain('.then(');
  });

  it('aliased named import → const uses local name, shim reads the original export', () => {
    const code = `
import { Original as Local } from './Heavy';
export function Panel() {
  return <section><Local /></section>;
}
`;
    const out = clientCode(code);
    expect(out).toMatch(/const Local = lazy\(/);
    expect(out).toMatch(/default:\s*m\.Original/);
  });

  it('barrel re-export rename → resolves to the leaf module and the real exported name', () => {
    const code = `
import { PaymentForm } from './components';
export function Panel() {
  return <section><PaymentForm /></section>;
}
`;
    const reExportMap: ReExportMap = new Map([
      ['/src/feat/components/index.ts', new Map([
        ['PaymentForm', { source: './PaymentForm', importedName: 'InternalPay' }],
      ])],
    ]);

    const result = detectWithBarrel(code, '/src/feat/Panel.tsx', reExportMap);
    const cand = result.lazy.find((c) => c.localName === 'PaymentForm');
    expect(cand?.resolvedSource).toBe('./components/PaymentForm');
    expect(cand?.importedName).toBe('InternalPay');

    const out = emit(code, '/src/feat/Panel.tsx', reExportMap);
    expect(out).toMatch(/import\('\.\/components\/PaymentForm'\)/);
    expect(out).toMatch(/default:\s*m\.InternalPay/);
    expect(out).not.toContain('m.PaymentForm');
  });

  it('namespace import is never lazified, even when used as <Ns />', () => {
    // `import * as Gallery` has no single default/named binding React.lazy can
    // resolve. Detection must not produce a candidate for it.
    const code = `
import * as Gallery from './Gallery';
export function Panel() {
  return <section><Gallery /></section>;
}
`;
    const result = detectWithBarrel(code, '/src/widgets/Panel.tsx', new Map());
    expect(names(result.lazy)).not.toContain('Gallery');
  });

  it('applyLazyTransforms ignores a namespace candidate (no rewrite, no injected imports)', () => {
    // Defense in depth: even if a namespace candidate is handed to the
    // transform directly, it must leave the import intact and not inject
    // unused `lazy`/`Suspense` imports or wrap the usage in Suspense.
    const code = `
import * as Gallery from './Gallery';
export function Panel() {
  return <section><Gallery /></section>;
}
`;
    const parsed = parseModule(code, '/src/widgets/Panel.tsx');
    const candidate: LazyCandidate = {
      localName: 'Gallery',
      source: './Gallery',
      importKind: 'namespace',
      importedName: null,
      jsxUsages: [],
      prefetch: 'viewport',
      suspenseGroup: null,
      conditional: false,
      jsxPosition: 0,
      reason: 'test',
    };
    const ast = structuredClone(parsed.ast) as Program;
    applyLazyTransforms(ast, [candidate]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = print(ast as any, tsx() as any).code;
    expect(out).toContain("import * as Gallery from './Gallery'");
    expect(out).not.toMatch(/\blazy\b/);
    expect(out).not.toMatch(/Suspense/);
  });

  it('default export re-exported through a barrel → no .then shim', () => {
    const code = `
import { Heavy } from './components';
export function Panel() {
  return <section><Heavy /></section>;
}
`;
    const reExportMap: ReExportMap = new Map([
      ['/src/feat/components/index.ts', new Map([
        ['Heavy', { source: './Heavy', importedName: 'default' }],
      ])],
    ]);

    const out = emit(code, '/src/feat/Panel.tsx', reExportMap);
    expect(out).toMatch(/import\('\.\/components\/Heavy'\)/);
    expect(out).not.toContain('.then(');
  });
});
