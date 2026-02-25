#!/usr/bin/env node
/**
 * Phantom benchmark runner
 *
 * Runs Vite builds with and without phantom-build on real-world React projects,
 * then compares bundle sizes, chunk counts, and build times.
 *
 * Usage:  node benchmarks/run.mjs [--project shadcn|bulletproof|all]
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { performance } from 'node:perf_hooks';

// ── Config ──────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname);
const PHANTOM_ROOT = resolve(ROOT, '..');
const RUNS = 3; // average over N builds for stable timing

const PROJECTS = {
  shadcn: {
    name: 'shadcn-admin',
    dir: join(ROOT, 'shadcn-admin'),
    buildCmd: 'npx vite build',
    distDir: 'dist',
    viteConfig: 'vite.config.ts',
  },
  bulletproof: {
    name: 'bulletproof-react (react-vite)',
    dir: join(ROOT, 'bulletproof-react/apps/react-vite'),
    buildCmd: 'npx vite build',
    distDir: 'dist',
    viteConfig: 'vite.config.ts',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function dirSizeBytes(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: false })) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isFile()) total += st.size;
    } catch { /* skip */ }
  }
  return total;
}

function countFiles(dir, ext) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (entry.endsWith(ext)) count++;
  }
  return count;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function pctChange(before, after) {
  if (before === 0) return 'N/A';
  const pct = ((after - before) / before) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function readManifest(dir) {
  // Check common locations for phantom manifest
  for (const candidate of ['phantom.manifest.json', '../phantom.manifest.json']) {
    const p = join(dir, candidate);
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8'));
    }
  }
  // Also check project root
  return null;
}

function runBuild(projectDir, buildCmd, env = {}) {
  try {
    execSync(buildCmd, {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, NODE_ENV: 'production' },
      timeout: 120_000,
    });
    return true;
  } catch (e) {
    console.error(`  Build failed: ${e.message?.slice(0, 200)}`);
    return false;
  }
}

// ── Collect metrics from a dist directory ───────────────────────────────

function collectMetrics(distDir, projectDir) {
  const totalSize = dirSizeBytes(distDir);
  const jsDir = join(distDir, 'assets');
  const jsSize = existsSync(jsDir) ? dirSizeBytes(jsDir) : dirSizeBytes(distDir);
  const jsFiles = countFiles(existsSync(jsDir) ? jsDir : distDir, '.js');
  const cssFiles = countFiles(existsSync(jsDir) ? jsDir : distDir, '.css');
  const mapFiles = countFiles(existsSync(jsDir) ? jsDir : distDir, '.js.map');

  // Look for phantom manifest
  const manifest = readManifest(projectDir) || readManifest(distDir);
  const phantomEntries = manifest?.entries ?? [];
  const handlerExtractions = phantomEntries.filter(e => e.kind === 'handler').length;
  const lazyWraps = phantomEntries.filter(e => e.kind === 'lazy').length;

  return {
    totalSize,
    jsSize,
    jsFiles,
    cssFiles,
    mapFiles,
    handlerExtractions,
    lazyWraps,
    totalExtractions: handlerExtractions + lazyWraps,
  };
}

// ── Vite config patching ────────────────────────────────────────────────

function getPhantomImportLine() {
  return `import phantom from '${PHANTOM_ROOT}/dist/vite.js';`;
}

function patchViteConfig(configPath) {
  const original = readFileSync(configPath, 'utf-8');
  const backup = original;

  // Add phantom import at top
  let patched = getPhantomImportLine() + '\n' + original;

  // Add phantom() to plugins array — insert right after `plugins: [`
  patched = patched.replace(
    /plugins:\s*\[/,
    'plugins: [\n    phantom({ silent: true }),'
  );

  writeFileSync(configPath, patched, 'utf-8');
  return backup;
}

function restoreViteConfig(configPath, backup) {
  writeFileSync(configPath, backup, 'utf-8');
}

// ── Run benchmark for one project ───────────────────────────────────────

async function benchmarkProject(key) {
  const proj = PROJECTS[key];
  if (!proj) {
    console.error(`Unknown project: ${key}`);
    return null;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Benchmarking: ${proj.name}`);
  console.log(`${'═'.repeat(60)}`);

  const distDir = join(proj.dir, proj.distDir);
  const configPath = join(proj.dir, proj.viteConfig);

  // ── Baseline builds ──────────────────────────────────────────────────
  console.log(`\n  [1/2] Baseline build (no phantom)...`);
  const baselineTimes = [];
  let baselineMetrics = null;

  for (let i = 0; i < RUNS; i++) {
    if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

    const t0 = performance.now();
    const ok = runBuild(proj.dir, proj.buildCmd);
    const elapsed = performance.now() - t0;

    if (!ok) {
      console.error(`  Baseline build ${i + 1} failed, aborting.`);
      return null;
    }

    baselineTimes.push(elapsed);
    if (i === RUNS - 1) {
      baselineMetrics = collectMetrics(distDir, proj.dir);
    }
    process.stdout.write(`    Run ${i + 1}/${RUNS}: ${(elapsed / 1000).toFixed(2)}s\n`);
  }

  // ── Phantom builds ───────────────────────────────────────────────────
  console.log(`\n  [2/2] Phantom build (with phantom-build)...`);

  // Patch vite config
  const configBackup = patchViteConfig(configPath);

  const phantomTimes = [];
  let phantomMetrics = null;

  for (let i = 0; i < RUNS; i++) {
    if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
    // Also clean any manifest from previous run
    const manifestPath = join(proj.dir, 'phantom.manifest.json');
    if (existsSync(manifestPath)) rmSync(manifestPath);

    const t0 = performance.now();
    const ok = runBuild(proj.dir, proj.buildCmd);
    const elapsed = performance.now() - t0;

    if (!ok) {
      console.error(`  Phantom build ${i + 1} failed.`);
      restoreViteConfig(configPath, configBackup);
      return null;
    }

    phantomTimes.push(elapsed);
    if (i === RUNS - 1) {
      phantomMetrics = collectMetrics(distDir, proj.dir);
    }
    process.stdout.write(`    Run ${i + 1}/${RUNS}: ${(elapsed / 1000).toFixed(2)}s\n`);
  }

  // Restore original config
  restoreViteConfig(configPath, configBackup);

  // ── Compute averages ─────────────────────────────────────────────────
  const avgBaseline = baselineTimes.reduce((a, b) => a + b, 0) / RUNS;
  const avgPhantom = phantomTimes.reduce((a, b) => a + b, 0) / RUNS;

  return {
    project: proj.name,
    baseline: { ...baselineMetrics, avgBuildTime: avgBaseline },
    phantom: { ...phantomMetrics, avgBuildTime: avgPhantom },
  };
}

// ── Pretty-print results ────────────────────────────────────────────────

function printResults(results) {
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log('  PHANTOM-BUILD BENCHMARK RESULTS');
  console.log(`${'═'.repeat(70)}\n`);

  for (const r of results) {
    if (!r) continue;
    const { project, baseline, phantom } = r;

    console.log(`  Project: ${project}`);
    console.log(`  ${'─'.repeat(58)}`);
    console.log(`  ${'Metric'.padEnd(30)} ${'Baseline'.padEnd(14)} ${'Phantom'.padEnd(14)} Change`);
    console.log(`  ${'─'.repeat(58)}`);

    const rows = [
      ['Build time (avg)',
        `${(baseline.avgBuildTime / 1000).toFixed(2)}s`,
        `${(phantom.avgBuildTime / 1000).toFixed(2)}s`,
        pctChange(baseline.avgBuildTime, phantom.avgBuildTime)],
      ['Total bundle size',
        formatBytes(baseline.totalSize),
        formatBytes(phantom.totalSize),
        pctChange(baseline.totalSize, phantom.totalSize)],
      ['JS chunks',
        String(baseline.jsFiles),
        String(phantom.jsFiles),
        pctChange(baseline.jsFiles, phantom.jsFiles)],
      ['CSS files',
        String(baseline.cssFiles),
        String(phantom.cssFiles),
        ''],
      ['Source maps',
        String(baseline.mapFiles),
        String(phantom.mapFiles),
        ''],
      ['Handlers extracted', '—', String(phantom.handlerExtractions), ''],
      ['Components lazified', '—', String(phantom.lazyWraps), ''],
      ['Total extractions', '—', String(phantom.totalExtractions), ''],
    ];

    for (const [label, b, p, change] of rows) {
      console.log(`  ${label.padEnd(30)} ${b.padEnd(14)} ${p.padEnd(14)} ${change}`);
    }
    console.log();
  }

  // ── JSON output for CI / blog posts ──────────────────────────────────
  const outPath = join(ROOT, 'results.json');
  const jsonOut = results.filter(Boolean).map(r => ({
    project: r.project,
    baseline: {
      bundleSizeBytes: r.baseline.totalSize,
      bundleSize: formatBytes(r.baseline.totalSize),
      jsChunks: r.baseline.jsFiles,
      buildTimeMs: Math.round(r.baseline.avgBuildTime),
    },
    phantom: {
      bundleSizeBytes: r.phantom.totalSize,
      bundleSize: formatBytes(r.phantom.totalSize),
      jsChunks: r.phantom.jsFiles,
      buildTimeMs: Math.round(r.phantom.avgBuildTime),
      handlersExtracted: r.phantom.handlerExtractions,
      componentsLazified: r.phantom.lazyWraps,
      totalExtractions: r.phantom.totalExtractions,
    },
    delta: {
      bundleSizePct: r.baseline.totalSize
        ? (((r.phantom.totalSize - r.baseline.totalSize) / r.baseline.totalSize) * 100).toFixed(1) + '%'
        : 'N/A',
      buildTimeOverheadPct: r.baseline.avgBuildTime
        ? (((r.phantom.avgBuildTime - r.baseline.avgBuildTime) / r.baseline.avgBuildTime) * 100).toFixed(1) + '%'
        : 'N/A',
      newChunks: r.phantom.jsFiles - r.baseline.jsFiles,
    },
  }));

  writeFileSync(outPath, JSON.stringify(jsonOut, null, 2));
  console.log(`  Results saved to: ${relative(process.cwd(), outPath)}`);
}

// ── Main ────────────────────────────────────────────────────────────────

const arg = process.argv[2]?.replace('--project=', '') ?? 'all';
const projectKeys = arg === 'all'
  ? Object.keys(PROJECTS)
  : [arg];

console.log('Phantom-Build Benchmark Runner');
console.log(`Projects: ${projectKeys.join(', ')}`);
console.log(`Runs per build: ${RUNS}`);

const results = [];
for (const key of projectKeys) {
  const r = await benchmarkProject(key);
  results.push(r);
}

printResults(results);
