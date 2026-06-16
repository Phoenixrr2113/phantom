import { describe, it, expect } from 'vitest';
import { computeContagion } from '../../src/rsc/contagion.js';
import type { ComponentGraph, RscFileResult } from '../../src/rsc/types.js';

function makeGraph(spec: Record<string, { v: RscFileResult['fileVerdict']; imports: string[]; bytes?: number }>): ComponentGraph {
  const files = new Map<string, RscFileResult>();
  for (const [file, s] of Object.entries(spec)) {
    files.set(file, {
      file,
      hasComponents: s.v !== 'non-component',
      fileVerdict: s.v,
      components: [],
      imports: s.imports,
      sizeBytes: s.bytes ?? 100,
    });
  }
  return { files, edgeResolution: 1 };
}

describe('computeContagion', () => {
  it('propagates client-ness importer→imported, transitively', () => {
    const g = makeGraph({
      '/App.tsx':     { v: 'must-be-client',  imports: ['/Layout.tsx'] },
      '/Layout.tsx':  { v: 'server-eligible', imports: ['/Card.tsx'] },
      '/Card.tsx':    { v: 'server-eligible', imports: [] },
      '/Sidebar.tsx': { v: 'server-eligible', imports: [] },
    });
    const r = computeContagion(g);
    expect(r.clientClosure.has('/App.tsx')).toBe(true);
    expect(r.clientClosure.has('/Layout.tsx')).toBe(true);  // contaminated by App
    expect(r.clientClosure.has('/Card.tsx')).toBe(true);    // transitively contaminated
    expect(r.realizableServer.has('/Sidebar.tsx')).toBe(true); // untouched → realizable
    expect(r.realizableServer.has('/Layout.tsx')).toBe(false);  // trapped
    expect(r.realizableServer.has('/Card.tsx')).toBe(false);
  });

  it('a mixed file is a seed and is not itself realizable-server', () => {
    const g = makeGraph({
      '/Mixed.tsx': { v: 'mixed', imports: ['/Pure.tsx'] },
      '/Pure.tsx':  { v: 'server-eligible', imports: [] },
    });
    const r = computeContagion(g);
    expect(r.clientClosure.has('/Mixed.tsx')).toBe(true);
    expect(r.clientClosure.has('/Pure.tsx')).toBe(true);     // pulled in by the mixed importer
    expect(r.realizableServer.has('/Mixed.tsx')).toBe(false);
    expect(r.realizableServer.size).toBe(0);
  });

  it('sums realizable-server bytes and tolerates a cycle', () => {
    const g = makeGraph({
      '/a.tsx': { v: 'server-eligible', imports: ['/b.tsx'], bytes: 10 },
      '/b.tsx': { v: 'server-eligible', imports: ['/a.tsx'], bytes: 20 }, // cycle, no client seed
      '/c.tsx': { v: 'must-be-client',  imports: ['/c.tsx'] },            // self-edge, must not infinite-loop
    });
    const r = computeContagion(g);
    expect(r.realizableServer.has('/a.tsx')).toBe(true);
    expect(r.realizableServer.has('/b.tsx')).toBe(true);
    expect(r.realizableServerBytes).toBe(30);
    expect(r.clientClosure.has('/c.tsx')).toBe(true);
  });
});
