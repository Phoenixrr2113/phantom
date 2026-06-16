import { describe, it, expect } from 'vitest';
import { findRescues, findHazardsInModule } from '../../src/rsc/rescue-hazards.js';
import { computeContagion } from '../../src/rsc/contagion.js';
import { parseModule } from '../../src/analyzer.js';
import type { ComponentGraph, RscFileResult } from '../../src/rsc/types.js';

function makeGraph(spec: Record<string, { v: RscFileResult['fileVerdict']; imports: string[]; name?: string }>): ComponentGraph {
  const files = new Map<string, RscFileResult>();
  for (const [file, s] of Object.entries(spec)) {
    files.set(file, {
      file,
      hasComponents: s.v !== 'non-component',
      fileVerdict: s.v,
      components: s.name ? [{ name: s.name, verdict: s.v === 'server-eligible' ? 'server-eligible' : 'must-be-client', reason: '', sizeBytes: 0 }] : [],
      imports: s.imports,
      sizeBytes: 100,
    });
  }
  return { files, edgeResolution: 1 };
}

describe('findRescues', () => {
  it('flags a server-eligible file imported by exactly one client file', () => {
    const g = makeGraph({
      '/Cart.tsx':        { v: 'must-be-client',  imports: ['/ProductGrid.tsx'], name: 'Cart' },
      '/ProductGrid.tsx': { v: 'server-eligible', imports: [], name: 'ProductGrid' },
    });
    const rescues = findRescues(g, computeContagion(g));
    expect(rescues).toHaveLength(1);
    expect(rescues[0].file).toBe('/ProductGrid.tsx');
    expect(rescues[0].trappedBy).toBe('/Cart.tsx');
    expect(rescues[0].hint).toMatch(/children/i);
    expect(rescues[0].hint).toContain('ProductGrid');
    expect(rescues[0].hint).toContain('Cart');
  });

  it('does NOT flag a file imported by multiple client files (shallow v1)', () => {
    const g = makeGraph({
      '/A.tsx':      { v: 'must-be-client',  imports: ['/Shared.tsx'] },
      '/B.tsx':      { v: 'must-be-client',  imports: ['/Shared.tsx'] },
      '/Shared.tsx': { v: 'server-eligible', imports: [] },
    });
    expect(findRescues(g, computeContagion(g))).toHaveLength(0);
  });

  it('does NOT flag an untrapped server-eligible file (no client importer)', () => {
    const g = makeGraph({
      '/Page.tsx':   { v: 'server-eligible', imports: ['/Widget.tsx'] },
      '/Widget.tsx': { v: 'server-eligible', imports: [] },
    });
    expect(findRescues(g, computeContagion(g))).toHaveLength(0);
  });

  it('does NOT flag a must-be-client file (only server-eligible files are rescuable)', () => {
    const g = makeGraph({
      '/Parent.tsx': { v: 'must-be-client', imports: ['/Child.tsx'] },
      '/Child.tsx':  { v: 'must-be-client', imports: [] },
    });
    expect(findRescues(g, computeContagion(g))).toHaveLength(0);
  });
});

const isClient = (n: string) => n === 'Client';

describe('findHazardsInModule', () => {
  it('flags an inline arrow function prop; ignores sibling serializable props', () => {
    const code = `export function Parent(){ return <Client onAction={()=>{}} label="x" count={3} ok={true} />; }`;
    const r = findHazardsInModule(parseModule(code, '/P.tsx'), code, '/P.tsx', isClient);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ prop: 'onAction', kind: 'function', component: 'Client' });
  });
  it('flags an identifier bound to a local function', () => {
    const code = `export function Parent(){ const handle=()=>{}; return <Client onClick={handle} />; }`;
    const r = findHazardsInModule(parseModule(code, '/P.tsx'), code, '/P.tsx', isClient);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ prop: 'onClick', kind: 'function' });
  });
  it('flags a class instance passed as a prop', () => {
    const code = `class Foo{} export function Parent(){ return <Client config={new Foo()} />; }`;
    const r = findHazardsInModule(parseModule(code, '/P.tsx'), code, '/P.tsx', isClient);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('class-instance');
  });
  it('does NOT flag JSX-as-prop or children (React elements are serializable in RSC)', () => {
    const code = `export function Parent(){ return <Client icon={<svg/>}>{<span/>}</Client>; }`;
    const r = findHazardsInModule(parseModule(code, '/P.tsx'), code, '/P.tsx', isClient);
    expect(r).toHaveLength(0);
  });
  it('does NOT flag serializable props, and ignores non-client components', () => {
    const code = `export function Parent(){ return (<div><Client title="x" n={3} on={true} data={{a:1}} /><Server onX={()=>{}} /></div>); }`;
    const r = findHazardsInModule(parseModule(code, '/P.tsx'), code, '/P.tsx', isClient);
    expect(r).toHaveLength(0); // Client: only serializable props; Server: not a client component
  });
});
