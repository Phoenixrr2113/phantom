import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const INTEGRATION_DIR = join(__dirname, '..', 'integration-test-webpack');
const DIST_DIR = join(INTEGRATION_DIR, 'dist');

let buildOutput: string;

beforeAll(() => {
  // Build phantom-build from TS first (integration test imports from dist/)
  execSync('npx tsc', { cwd: join(__dirname, '..'), timeout: 30000 });

  // Run the Webpack build
  buildOutput = execSync('npx webpack', {
    cwd: INTEGRATION_DIR,
    encoding: 'utf-8',
    timeout: 60000,
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function getChunkFiles(): string[] {
  return readdirSync(DIST_DIR).filter(
    (f) => f.includes('phantom_seg_') && f.endsWith('.js') && !f.endsWith('.js.map'),
  );
}

function getMainBundle(): string {
  return readFileSync(join(DIST_DIR, 'main.js'), 'utf-8');
}

function getAllChunkCode(): string {
  return getChunkFiles()
    .map((f) => readFileSync(join(DIST_DIR, f), 'utf-8'))
    .join('\n');
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Webpack integration', () => {
  describe('build output', () => {
    it('build completes without errors', () => {
      expect(buildOutput).toBeDefined();
      expect(buildOutput).toContain('compiled successfully');
    });

    it('produces at least 4 phantom chunk files', () => {
      const chunks = getChunkFiles();
      expect(chunks.length).toBeGreaterThanOrEqual(4);
    });

    it('each chunk has a source map', () => {
      const chunks = getChunkFiles();
      const allFiles = readdirSync(DIST_DIR);
      for (const chunk of chunks) {
        expect(allFiles).toContain(`${chunk}.map`);
      }
    });

    it('build summary reports 4 handlers from 1 module', () => {
      expect(buildOutput).toContain('Handlers extracted: 4');
    });
  });

  describe('main bundle', () => {
    it('contains __phantom_lazy stubs', () => {
      const main = getMainBundle();
      expect(main).toContain('__phantom_lazy');
    });

    it('does NOT contain handler bodies (they were extracted)', () => {
      const main = getMainBundle();
      // handleScroll: localStorage.setItem("scrolled", "true") — unique to handler
      expect(main).not.toContain('"scrolled"');
      // handleSubmit: new FormData(form) — the handler body
      expect(main).not.toContain('new FormData');
      // handleFormat: alert with Total: pattern
      expect(main).not.toMatch(/alert\(`Total:/);
    });

    it('preserves useMemo logic (PureComputation stays in bundle)', () => {
      const main = getMainBundle();
      // useMemo callback with .reduce((sum, item) => sum + item.price, 0)
      expect(main).toContain('item.price');
    });
  });

  describe('chunk modules', () => {
    it('chunks contain extracted handler logic', () => {
      const allChunks = getAllChunkCode();
      expect(allChunks).toContain('scrollTo');
      expect(allChunks).toContain('FormData');
      expect(allChunks).toContain('alert');
    });

    it('handleSubmit chunk has preventDefault', () => {
      const allChunks = getAllChunkCode();
      expect(allChunks).toContain('preventDefault');
    });

    it('formatCurrency chunk imports utils (import rewriting)', () => {
      const allChunks = getAllChunkCode();
      // Webpack rewrites imports to __webpack_require__ calls
      expect(allChunks).toContain('formatCurrency');
      // The chunk should reference the utils module via webpack's module system
      expect(allChunks).toContain('utils');
    });

    it('chunk code is non-trivial (contains actual function bodies)', () => {
      const chunks = getChunkFiles();
      for (const chunk of chunks) {
        const code = readFileSync(join(DIST_DIR, chunk), 'utf-8');
        // Each chunk should have more than just boilerplate
        expect(code.length).toBeGreaterThan(100);
        // Each chunk should contain a function definition
        expect(code).toContain('function seg_');
      }
    });
  });

  describe('manifest', () => {
    it('manifest has 4 entries with correct structure', () => {
      const manifestPath = join(INTEGRATION_DIR, 'phantom.manifest.json');
      expect(existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.version).toBe(1);
      expect(manifest.entries.length).toBe(4);
      expect(manifest.stats.totalSegmentsExtracted).toBe(4);

      for (const entry of manifest.entries) {
        expect(entry.segmentId).toMatch(/^seg_[0-9a-f]+$/);
        expect(entry.sourceFile).toContain('App.tsx');
        expect(entry.virtualId).toContain('phantom:');
        expect(entry.name).toBeDefined();
      }
    });
  });
});
