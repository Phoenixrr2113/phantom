import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeRscReadiness } from '../../src/rsc/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'cli.ts');
const fixture = (n: string): string => join(root, 'test', 'fixtures', 'rsc', n);

// Real third-party codebases checked out under benchmarks/. The edge-resolution
// gate is the headline correctness criterion: under-resolved import edges
// silently over-report server-eligibility, so the resolver must clear >= 90% on
// real code, not just hand-built fixtures. Skipped (not failed) when a corpus
// isn't present on the machine, so CI without the benchmarks stays green.
const CORPORA = [
  { name: 'shadcn-admin', dir: join(root, 'benchmarks', 'shadcn-admin', 'src') },
  {
    name: 'bulletproof-react',
    dir: join(root, 'benchmarks', 'bulletproof-react', 'apps', 'react-vite', 'src'),
  },
];

function runCLI(args: string): string {
  return execSync(`npx tsx ${CLI} ${args}`, { encoding: 'utf-8', cwd: root, timeout: 30000 });
}

describe('phantom rsc CLI', () => {
  it('prints a terminal summary for a fixture directory', () => {
    const out = runCLI(`rsc ${fixture('graph-basic')}`);
    expect(out).toContain('RSC Readiness');
    expect(out).toContain('frontier');
  });

  it('--json emits valid JSON parseable to an RscReport', () => {
    const out = runCLI(`rsc ${fixture('graph-basic')} --json`);
    const report = JSON.parse(out);
    expect(report.componentFiles).toBe(4);
    expect(report.clientFrontier).toHaveLength(1);
    expect(Array.isArray(report.rescues)).toBe(true);
    expect(Array.isArray(report.hazards)).toBe(true);
  });

  it('documents the rsc command in --help', () => {
    const out = runCLI('--help');
    expect(out).toContain('phantom rsc');
  });

  it('exits with an error for a missing directory', () => {
    expect(() => runCLI('rsc /nonexistent/dir/xyz')).toThrow();
  });
});

describe('real-corpus edge-resolution gate (skips if corpus absent)', () => {
  for (const { name, dir } of CORPORA) {
    it.skipIf(!existsSync(dir))(
      `${name}: runs without crashing and resolves >= 90% of internal import edges`,
      () => {
        const report = analyzeRscReadiness(dir);
        expect(report.componentFiles).toBeGreaterThan(0);
        expect(report.edgeResolutionPct).toBeGreaterThanOrEqual(90);
      },
      120000, // generous timeout for a real codebase
    );
  }
});
