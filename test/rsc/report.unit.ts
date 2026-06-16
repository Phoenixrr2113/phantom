import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeRscReadiness, toJSON, toMarkdown, toTerminal } from '../../src/rsc/index.js';
import type { RscReport } from '../../src/rsc/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, '..', 'fixtures', 'rsc', name);

describe('analyzeRscReadiness', () => {
  it('produces the expected report for graph-basic', () => {
    const r = analyzeRscReadiness(fixture('graph-basic'));
    expect(r.componentFiles).toBe(4);              // App, Layout, Card, Sidebar (index.ts is non-component)
    expect(r.edgeResolutionPct).toBeCloseTo(200 / 3); // 2 of 3 internal edges (Sidebar→./Gone unresolved)
    expect(r.serverEligibleUpperBound).toBe(3);    // Layout, Card, Sidebar
    expect(r.realizableServerFiles).toBe(1);       // only Sidebar escapes App's blast radius
    expect(r.clientFrontier).toHaveLength(1);      // just App (Layout/Card inherit)
    expect(r.clientFrontier[0]).toMatch(/App\.tsx$/);
    expect(r.rescues).toHaveLength(2);             // Layout (via App), Card (via Layout)
    expect(r.hazards).toHaveLength(0);             // no server-eligible file passes a function to a client child here
  });

  it('detects a serialization hazard across a real server→client boundary', () => {
    const r = analyzeRscReadiness(fixture('hazard-proj'));
    expect(r.hazards).toHaveLength(1);
    expect(r.hazards[0]).toMatchObject({ prop: 'onSave', kind: 'function' });
    expect(r.hazards[0].file).toMatch(/Page\.tsx$/);
  });

  it('round-trips through toJSON and emits markdown/terminal', () => {
    const r = analyzeRscReadiness(fixture('graph-basic'));
    const parsed = JSON.parse(toJSON(r)) as RscReport;
    expect(parsed.componentFiles).toBe(r.componentFiles);
    expect(parsed.clientFrontier).toEqual(r.clientFrontier);
    expect(toMarkdown(r)).toContain('RSC Readiness Report');
    expect(toTerminal(r)).toContain('frontier');
  });
});
