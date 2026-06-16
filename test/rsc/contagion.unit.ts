import { describe, it, expect } from 'vitest';
import { computeContagion, computeFrontier } from '../../src/rsc/contagion.js';
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

describe('computeFrontier', () => {
  it('returns only the topmost client node (minimal set)', () => {
    const g = makeGraph({
      '/App.tsx':     { v: 'must-be-client',  imports: ['/Layout.tsx'] },
      '/Layout.tsx':  { v: 'server-eligible', imports: ['/Card.tsx'] }, // client by contagion
      '/Card.tsx':    { v: 'server-eligible', imports: [] },            // client by contagion
      '/Sidebar.tsx': { v: 'server-eligible', imports: [] },
    });
    const { clientClosure } = computeContagion(g);
    const frontier = computeFrontier(g, clientClosure);
    expect(frontier.has('/App.tsx')).toBe(true);
    expect(frontier.has('/Layout.tsx')).toBe(false); // inherits from App
    expect(frontier.has('/Card.tsx')).toBe(false);   // inherits transitively
    expect(frontier.size).toBe(1);
  });

  it('a client child imported only by a SERVER parent is on the frontier (server parent stays server)', () => {
    const g = makeGraph({
      '/Page.tsx':   { v: 'server-eligible', imports: ['/Widget.tsx'] },
      '/Widget.tsx': { v: 'must-be-client',  imports: [] },
    });
    const { clientClosure, realizableServer } = computeContagion(g);
    const frontier = computeFrontier(g, clientClosure);
    expect(frontier.has('/Widget.tsx')).toBe(true);
    expect(frontier.has('/Page.tsx')).toBe(false);
    expect(realizableServer.has('/Page.tsx')).toBe(true); // server parent NOT dragged client
    expect(frontier.size).toBe(1);
  });

  it('two independent client roots sharing a contaminated child both stay on the frontier', () => {
    const g = makeGraph({
      '/A.tsx': { v: 'must-be-client',  imports: ['/Shared.tsx'] },
      '/B.tsx': { v: 'must-be-client',  imports: ['/Shared.tsx'] },
      '/Shared.tsx': { v: 'server-eligible', imports: [] },
    });
    const { clientClosure } = computeContagion(g);
    const frontier = computeFrontier(g, clientClosure);
    expect(frontier.has('/A.tsx')).toBe(true);
    expect(frontier.has('/B.tsx')).toBe(true);
    expect(frontier.has('/Shared.tsx')).toBe(false); // inherits from both
    expect(frontier.size).toBe(2);
  });

  it('covers a client import cycle with no acyclic entry (never empty)', () => {
    const g = makeGraph({
      '/A.tsx': { v: 'must-be-client', imports: ['/B.tsx'] },
      '/B.tsx': { v: 'must-be-client', imports: ['/A.tsx'] },
    });
    const { clientClosure } = computeContagion(g);
    const frontier = computeFrontier(g, clientClosure);
    expect(frontier.size).toBe(1); // one representative covers the whole cycle
    // every client file must be the frontier or reachable from it
    expect(frontier.has('/A.tsx') || frontier.has('/B.tsx')).toBe(true);
  });

  it('covers a self-importing client file', () => {
    const g = makeGraph({ '/Solo.tsx': { v: 'must-be-client', imports: ['/Solo.tsx'] } });
    const { clientClosure } = computeContagion(g);
    const frontier = computeFrontier(g, clientClosure);
    expect(frontier.has('/Solo.tsx')).toBe(true);
    expect(frontier.size).toBe(1);
  });

  it('does not over-add when a cycle sits below an acyclic client root', () => {
    const g = makeGraph({
      '/Root.tsx': { v: 'must-be-client',  imports: ['/A.tsx'] },
      '/A.tsx':    { v: 'server-eligible', imports: ['/B.tsx'] },
      '/B.tsx':    { v: 'server-eligible', imports: ['/A.tsx'] }, // cycle below Root
    });
    const { clientClosure } = computeContagion(g);
    const frontier = computeFrontier(g, clientClosure);
    expect(frontier.size).toBe(1);
    expect(frontier.has('/Root.tsx')).toBe(true); // Root covers A and B
  });
});
