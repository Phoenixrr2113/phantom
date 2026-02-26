import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const INTEGRATION_DIR = join(__dirname, '..', 'integration-test-rsbuild');
const DIST_DIR = join(INTEGRATION_DIR, 'dist');

let buildOutput: string;

beforeAll(() => {
  // Build phantom-build from TS first (integration test imports from dist/)
  execSync('npx tsc', { cwd: join(__dirname, '..'), timeout: 30000 });

  // Run the Rsbuild build
  buildOutput = execSync('npx rsbuild build', {
    cwd: INTEGRATION_DIR,
    encoding: 'utf-8',
    timeout: 60000,
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Rsbuild outputs JS to dist/static/js/ with async chunks in dist/static/js/async/ */
function getJsDir(): string {
  return join(DIST_DIR, 'static', 'js');
}

/** Find all JS files recursively under the JS output dir (excluding source maps and lib chunks) */
function getAllJsFiles(dir = getJsDir()): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...getAllJsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.js.map')) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function getMainBundle(): string {
  const jsDir = getJsDir();
  const main = readdirSync(jsDir).find(
    (f) => f.startsWith('index') && f.endsWith('.js') && !f.endsWith('.js.map'),
  );
  if (!main) throw new Error('Main bundle not found in ' + jsDir);
  return readFileSync(join(jsDir, main), 'utf-8');
}

function getChunkFiles(): string[] {
  // Rsbuild puts async chunks in dist/static/js/async/
  const asyncDir = join(getJsDir(), 'async');
  if (!existsSync(asyncDir)) return [];
  return readdirSync(asyncDir).filter(
    (f) => f.endsWith('.js') && !f.endsWith('.js.map'),
  );
}

function getAllChunkCode(): string {
  const asyncDir = join(getJsDir(), 'async');
  if (!existsSync(asyncDir)) return '';
  return getChunkFiles()
    .map((f) => readFileSync(join(asyncDir, f), 'utf-8'))
    .join('\n');
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Rsbuild integration', () => {
  describe('build output', () => {
    it('build completes without errors', () => {
      expect(buildOutput).toBeDefined();
      expect(buildOutput).toContain('[phantom] Build complete');
    });

    it('produces at least 1 async chunk file (grouped handlers)', () => {
      const chunks = getChunkFiles();
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('each JS file has a source map', () => {
      const allJs = getAllJsFiles();
      for (const jsFile of allJs) {
        expect(existsSync(`${jsFile}.map`)).toBe(true);
      }
    });

    it('build summary reports 4 handlers from 1 module', () => {
      expect(buildOutput).toContain('Handlers extracted: 4');
    });
  });

  describe('main bundle', () => {
    it('contains $p stubs', () => {
      const main = getMainBundle();
      expect(main).toContain('$p');
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
      // Rspack rewrites imports similarly to webpack
      expect(allChunks).toContain('formatCurrency');
    });

    it('chunk code is non-trivial (contains actual function bodies)', () => {
      const asyncDir = join(getJsDir(), 'async');
      const chunks = getChunkFiles();
      for (const chunk of chunks) {
        const code = readFileSync(join(asyncDir, chunk), 'utf-8');
        // Each chunk should have more than just boilerplate
        expect(code.length).toBeGreaterThan(100);
        // Each chunk should contain segment function definitions
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
