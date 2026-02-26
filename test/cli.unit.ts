import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const FIXTURES_DIR = join(__dirname, 'fixtures');

function runCLI(args: string): string {
  return execSync(`npx tsx ${CLI_PATH} ${args}`, {
    encoding: 'utf-8',
    cwd: join(__dirname, '..'),
    timeout: 15000,
  });
}

describe('phantom CLI', () => {
  describe('analyze command', () => {
    it('shows segment table for event-handler.tsx', () => {
      const output = runCLI(`analyze ${join(FIXTURES_DIR, 'event-handler.tsx')} --min-handler-size 0`);

      expect(output).toContain('Phantom Analysis');
      expect(output).toContain('EventHandler');
      expect(output).toContain('Chunks extracted:');
      // Should extract at least 3 handlers (with minHandlerSize=0 to include small test fixtures)
      expect(output).toMatch(/Chunks extracted: [3-9]/);
    });

    it('shows no extractions for pure-memo.tsx', () => {
      const output = runCLI(`analyze ${join(FIXTURES_DIR, 'pure-memo.tsx')}`);

      expect(output).toContain('Phantom Analysis');
      expect(output).toContain('PureComputation');
      expect(output).toContain('Chunks extracted: 0');
    });

    it('shows mixed classifications for mixed.tsx', () => {
      const output = runCLI(`analyze ${join(FIXTURES_DIR, 'mixed.tsx')}`);

      expect(output).toContain('Phantom Analysis');
      expect(output).toContain('EventHandler');
      expect(output).toContain('PureComputation');
    });

    it('respects --threshold flag', () => {
      // Very high threshold should extract nothing
      const output = runCLI(`analyze ${join(FIXTURES_DIR, 'mixed.tsx')} --threshold 0.99`);
      expect(output).toContain('Threshold: 0.99');
      expect(output).toContain('Chunks extracted: 0');
    });

    it('shows confidence scores for each segment', () => {
      const output = runCLI(`analyze ${join(FIXTURES_DIR, 'event-handler.tsx')}`);
      // Should contain numeric confidence values like 0.90
      expect(output).toMatch(/\d\.\d{2}/);
    });

    it('shows classification reasons', () => {
      const output = runCLI(`analyze ${join(FIXTURES_DIR, 'event-handler.tsx')}`);
      // Reasons appear with → prefix
      expect(output).toContain('→');
    });

    it('shows chunk sizes in KB', () => {
      const output = runCLI(`analyze ${join(FIXTURES_DIR, 'event-handler.tsx')} --min-handler-size 0`);
      expect(output).toMatch(/\d+\.\d KB/);
    });
  });

  describe('error handling', () => {
    it('exits with error for missing file', () => {
      expect(() => runCLI('analyze /nonexistent/file.tsx')).toThrow();
    });

    it('exits with error for unknown command', () => {
      expect(() => runCLI('unknown')).toThrow();
    });

    it('exits with error when no arguments provided', () => {
      expect(() => runCLI('')).toThrow();
    });
  });

  describe('help', () => {
    it('shows usage with --help', () => {
      const output = runCLI('--help');
      expect(output).toContain('Usage:');
      expect(output).toContain('phantom analyze');
      expect(output).toContain('--threshold');
    });

    it('shows usage with -h', () => {
      const output = runCLI('-h');
      expect(output).toContain('Usage:');
    });
  });
});
