import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const INTEGRATION_DIR = join(__dirname, '..', 'integration-test');
const DIST_ASSETS = join(INTEGRATION_DIR, 'dist', 'assets');

let buildOutput: string;

beforeAll(() => {
  // Build phantom-build from TS first (integration test imports from dist/)
  execSync('npx tsc', { cwd: join(__dirname, '..'), timeout: 30000 });

  // Run the Vite build
  buildOutput = execSync('npm run build', {
    cwd: INTEGRATION_DIR,
    encoding: 'utf-8',
    timeout: 30000,
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function getChunkFiles(): string[] {
  return readdirSync(DIST_ASSETS).filter(
    (f) => f.includes('phantom_') && f.endsWith('.js') && !f.endsWith('.js.map'),
  );
}

function getMainBundle(): string {
  const mainFile = readdirSync(DIST_ASSETS).find(
    (f) => f.startsWith('index-') && f.endsWith('.js') && !f.endsWith('.js.map'),
  );
  expect(mainFile).toBeDefined();
  return readFileSync(join(DIST_ASSETS, mainFile!), 'utf-8');
}

function getAllChunkCode(): string {
  return getChunkFiles()
    .map((f) => readFileSync(join(DIST_ASSETS, f), 'utf-8'))
    .join('\n');
}

function readChunk(segId: string): string {
  const file = getChunkFiles().find((f) => f.includes(segId));
  expect(file, `chunk file for ${segId} not found`).toBeDefined();
  return readFileSync(join(DIST_ASSETS, file!), 'utf-8');
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Vite integration', () => {
  describe('build output', () => {
    it('build completes without errors', () => {
      expect(buildOutput).toBeDefined();
    });

    it('produces at least 1 phantom chunk file (grouped module)', () => {
      const chunks = getChunkFiles();
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('each chunk has a source map', () => {
      const chunks = getChunkFiles();
      const allFiles = readdirSync(DIST_ASSETS);
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
      // These are handler-specific patterns unique to extracted handlers:
      // handleScroll: localStorage.setItem("scrolled", "true") — this exact string
      expect(main).not.toContain('"scrolled"');
      // handleSubmit: new FormData(form) — the handler body
      expect(main).not.toContain('new FormData');
      // handleFormat: the formatCurrency call inside the handler body with alert
      // (formatCurrency is used in JSX too, so check the handler-specific pattern)
      expect(main).not.toMatch(/alert\(`Total:/);
    });

    it('preserves useMemo logic (PureComputation stays in bundle)', () => {
      const main = getMainBundle();
      // useMemo callback with reduce should stay in main bundle
      expect(main).toContain('reduce');
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

    it('formatCurrency chunk imports from main bundle (import rewriting)', () => {
      const allChunks = getAllChunkCode();
      // Vite rewrites the import to reference the main bundle
      expect(allChunks).toContain('formatCurrency');
      // Should import from the index bundle (not a relative ./utils path)
      expect(allChunks).toMatch(/import.*from\s*"\.\/index-/);
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
