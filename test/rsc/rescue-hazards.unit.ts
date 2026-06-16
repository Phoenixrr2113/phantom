import { describe, it, expect } from 'vitest';
import { findRescues } from '../../src/rsc/rescue-hazards.js';
import { computeContagion } from '../../src/rsc/contagion.js';
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
