import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'cli.ts');
const fixture = (n: string): string => join(root, 'test', 'fixtures', 'rsc', n);

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
