import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// Type-level test: the plugin factory must be callable with no arguments.
// Compiles test/fixtures/consumer-types.ts (which calls phantom()/phantom.vite()
// with and without options) using the project's compiler settings.
describe('plugin factory: consumer type ergonomics', () => {
  it('phantom() and phantom.vite() type-check with and without options', () => {
    const root = join(__dirname, '..');
    const config = join(__dirname, 'fixtures', 'tsconfig.types.json');
    let ok = true;
    let output = '';
    try {
      execSync(`npx tsc -p "${config}"`, { cwd: root, encoding: 'utf-8', timeout: 60000 });
    } catch (err) {
      ok = false;
      const e = err as { stdout?: string; stderr?: string };
      output = (e.stdout ?? '') + (e.stderr ?? '');
    }
    expect(ok, output).toBe(true);
  });
});
