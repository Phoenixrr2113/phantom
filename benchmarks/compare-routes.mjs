#!/usr/bin/env node
/**
 * Phantom route-chunk comparison
 *
 * Builds baseline and phantom versions of a project, then compares
 * the SIZE OF EACH ROUTE CHUNK — not the full dependency tree.
 *
 * This shows the real impact: the route chunk is what loads ON TOP of
 * shared code when you navigate to a page. Shared deps are identical
 * in both builds.
 *
 * Usage:
 *   node compare-routes.mjs                  # runs shadcn-admin (default)
 *   node compare-routes.mjs shadcn-admin
 *   node compare-routes.mjs bulletproof-react
 *   node compare-routes.mjs all              # runs both projects
 */

import { execSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync,
  statSync, rmSync, mkdirSync, cpSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PHANTOM_ROOT = resolve(ROOT, '..');
const RESULTS_DIR = join(ROOT, 'route-comparison');

// ── Project configurations ──────────────────────────────────────────────

const PROJECTS = {
  'shadcn-admin': {
    dir: join(ROOT, 'shadcn-admin'),
    distDir: join(ROOT, 'shadcn-admin', 'dist'),
    configPath: join(ROOT, 'shadcn-admin', 'vite.config.ts'),
    // Simple config — no existing build section
    patchManifest(config) {
      return config.replace(/}\)\s*$/, '  build: {\n    manifest: true,\n  },\n})');
    },
  },
  'bulletproof-react': {
    dir: join(ROOT, 'bulletproof-react', 'apps', 'react-vite'),
    distDir: join(ROOT, 'bulletproof-react', 'apps', 'react-vite', 'dist'),
    configPath: join(ROOT, 'bulletproof-react', 'apps', 'react-vite', 'vite.config.ts'),
    // Already has build.rollupOptions — inject manifest: true into existing build block
    patchManifest(config) {
      return config.replace(/build:\s*\{/, 'build: {\n    manifest: true,');
    },
  },
};

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function buildProject(project, addPhantom) {
  const { dir, distDir, configPath, patchManifest } = project;
  const original = readFileSync(configPath, 'utf-8');
  let config = original;

  if (addPhantom) {
    config = `import phantom from '${PHANTOM_ROOT}/dist/vite.js';\n` + config;
    config = config.replace(/plugins:\s*\[/, 'plugins: [\n    phantom({ silent: true }),');
  }

  // Add manifest: true
  config = patchManifest(config);

  writeFileSync(configPath, config, 'utf-8');

  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  const mp = join(dir, 'phantom.manifest.json');
  if (existsSync(mp)) rmSync(mp);

  try {
    execSync('npx vite build', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 120_000,
    });
  } finally {
    // Always restore original config
    writeFileSync(configPath, original, 'utf-8');
  }
}

function analyzeChunks(distDir) {
  const manifest = JSON.parse(
    readFileSync(join(distDir, '.vite/manifest.json'), 'utf-8')
  );

  const chunks = { entry: [], route: [], phantom: [], shared: [] };

  for (const [src, entry] of Object.entries(manifest)) {
    const size = statSync(join(distDir, entry.file)).size;
    const fileName = entry.file.replace('assets/', '');

    const info = {
      src,
      file: fileName,
      size,
      routeName: src
        .replace(/^src\/routes\//, '')
        .replace(/^src\/features\//, 'features/')
        .replace(/^src\/components\//, 'components/')
        .replace(/^src\/app\/routes\//, '')
        .replace(/\?tsr-split=component$/, '')
        .replace(/\/index\.(tsx|ts)$/, '')
        .replace(/\.(tsx|ts)$/, ''),
    };

    if (entry.isEntry) {
      chunks.entry.push(info);
    } else if (fileName.includes('phantom')) {
      chunks.phantom.push(info);
    } else if (entry.isDynamicEntry) {
      chunks.route.push(info);
    } else {
      chunks.shared.push(info);
    }
  }

  for (const cat of Object.values(chunks)) {
    cat.sort((a, b) => b.size - a.size);
  }

  return chunks;
}

function runComparison(projectName) {
  const project = PROJECTS[projectName];
  if (!project) {
    console.error(`Unknown project: ${projectName}`);
    console.error(`Available: ${Object.keys(PROJECTS).join(', ')}`);
    process.exit(1);
  }

  const resultsSubdir = join(RESULTS_DIR, projectName);

  console.log(`\n${'━'.repeat(80)}`);
  console.log(`  PROJECT: ${projectName}`);
  console.log(`${'━'.repeat(80)}`);

  console.log('Building baseline...');
  buildProject(project, false);

  mkdirSync(resultsSubdir, { recursive: true });
  cpSync(
    join(project.distDir, '.vite/manifest.json'),
    join(resultsSubdir, 'baseline-manifest.json'),
  );

  const baseline = analyzeChunks(project.distDir);

  console.log('Building with phantom...');
  buildProject(project, true);

  cpSync(
    join(project.distDir, '.vite/manifest.json'),
    join(resultsSubdir, 'phantom-manifest.json'),
  );

  const phantomResult = analyzeChunks(project.distDir);

  // ── Match route chunks ────────────────────────────────────────────

  const baselineRouteMap = new Map();
  for (const r of baseline.route) baselineRouteMap.set(r.src, r);

  const phantomRouteMap = new Map();
  for (const r of phantomResult.route) phantomRouteMap.set(r.src, r);

  const matchedRoutes = [];
  const allRouteSources = new Set([...baselineRouteMap.keys(), ...phantomRouteMap.keys()]);

  for (const src of allRouteSources) {
    const b = baselineRouteMap.get(src);
    const p = phantomRouteMap.get(src);
    if (b && p) {
      matchedRoutes.push({
        route: b.routeName,
        baselineSize: b.size,
        phantomSize: p.size,
        saved: b.size - p.size,
      });
    }
  }

  matchedRoutes.sort((a, b) => b.saved - a.saved);

  // ── Print results ─────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(80)}`);
  console.log('  ROUTE CHUNK SIZES: What loads when you navigate to each page');
  console.log('  (Shared deps like React, Radix, etc. are identical — only route-specific code)');
  console.log(`${'═'.repeat(80)}\n`);

  console.log(`  ${'Route'.padEnd(45)} ${'Baseline'.padEnd(12)} ${'Phantom'.padEnd(12)} Saved`);
  console.log(`  ${'─'.repeat(75)}`);

  let totalBaseline = 0, totalPhantom = 0, totalSaved = 0;

  for (const r of matchedRoutes) {
    const name = r.route.slice(0, 43);
    const savedStr = r.saved > 0
      ? `${fmt(r.saved)} (−${((r.saved / r.baselineSize) * 100).toFixed(0)}%)`
      : `+${fmt(-r.saved)}`;

    console.log(
      `  ${name.padEnd(45)} ${fmt(r.baselineSize).padEnd(12)} ${fmt(r.phantomSize).padEnd(12)} ${savedStr}`
    );

    totalBaseline += r.baselineSize;
    totalPhantom += r.phantomSize;
    totalSaved += r.saved;
  }

  console.log(`  ${'─'.repeat(75)}`);
  console.log(
    `  ${'TOTAL route-specific JS'.padEnd(45)} ${fmt(totalBaseline).padEnd(12)} ${fmt(totalPhantom).padEnd(12)} ${fmt(totalSaved)} (−${((totalSaved / totalBaseline) * 100).toFixed(0)}%)`
  );

  // Show what phantom created
  const phantomChunkTotal = phantomResult.phantom.reduce((s, c) => s + c.size, 0);
  console.log(`\n  Phantom created ${phantomResult.phantom.length} on-demand chunks (${fmt(phantomChunkTotal)} total)`);
  console.log('  These load ONLY when the user clicks a button, opens a modal, etc.\n');

  if (phantomResult.phantom.length > 0) {
    console.log('  Largest on-demand chunks:');
    for (const c of phantomResult.phantom.slice(0, 10)) {
      const name = c.src.replace('src/features/', '').replace('src/components/', '').slice(0, 50);
      console.log(`    ${fmt(c.size).padStart(10)}  ${name}`);
    }
  }

  // Entry + shared comparison
  const baseEntrySize = baseline.entry.reduce((s, c) => s + c.size, 0);
  const phantomEntrySize = phantomResult.entry.reduce((s, c) => s + c.size, 0);
  const baseSharedSize = baseline.shared.reduce((s, c) => s + c.size, 0);
  const phantomSharedSize = phantomResult.shared.reduce((s, c) => s + c.size, 0);

  console.log(`\n  Context (unchanged between builds):`);
  console.log(`    Entry chunks:   ${fmt(baseEntrySize)} → ${fmt(phantomEntrySize)}`);
  console.log(`    Shared chunks:  ${fmt(baseSharedSize)} → ${fmt(phantomSharedSize)}`);

  // Summary
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  BOTTOM LINE`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Route-specific JS reduced by ${fmt(totalSaved)} (−${((totalSaved / totalBaseline) * 100).toFixed(0)}%) across ${matchedRoutes.length} routes`);
  console.log(`  ${phantomResult.phantom.length} interaction handlers now load on-demand instead of on navigation`);
  console.log(`${'═'.repeat(80)}\n`);

  return {
    project: projectName,
    matchedRoutes,
    totalBaseline,
    totalPhantom,
    totalSaved,
    phantomChunks: phantomResult.phantom.length,
    phantomChunkTotal,
  };
}

// ── Main ────────────────────────────────────────────────────────────────

const arg = process.argv[2] || 'shadcn-admin';
const projectNames = arg === 'all' ? Object.keys(PROJECTS) : [arg];
const allResults = [];

for (const name of projectNames) {
  allResults.push(runComparison(name));
}

// Save JSON results
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(
  join(RESULTS_DIR, 'results.json'),
  JSON.stringify(allResults, null, 2),
  'utf-8',
);

console.log(`\nResults saved to ${RESULTS_DIR}/results.json`);
