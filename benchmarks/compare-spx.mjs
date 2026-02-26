#!/usr/bin/env node
/**
 * Phantom benchmark for SPX_CLIENT (Rspack-based project)
 *
 * Patches clientConfigBuilder.ts to add phantom, builds with and without,
 * then compares JS bundle sizes.
 */

import { execSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync,
  readdirSync, statSync, rmSync, mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const PHANTOM_ROOT = resolve(import.meta.dirname, '..');
const SPX_ROOT = '/Users/randywilson/Desktop/PMI/SPX_CLIENT';
const CONFIG_PATH = join(SPX_ROOT, 'scripts/configBuilders/clientConfigBuilder.ts');
const RESULTS_DIR = join(import.meta.dirname, 'spx-results');

// ── Helpers ─────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function getJSFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isFile() && entry.endsWith('.js') && !entry.endsWith('.js.map')) {
        files.push({ file: entry, size: statSync(full).size });
      }
    } catch { /* skip */ }
  }
  return files.sort((a, b) => b.size - a.size);
}

function totalSize(files) {
  return files.reduce((sum, f) => sum + f.size, 0);
}

function buildClient(label, extraEnv = {}) {
  console.log(`  Building ${label}...`);
  try {
    const binDir = join(SPX_ROOT, 'node_modules', '.bin');
    const PATH = `${binDir}:${process.env.PATH}`;
    execSync('cross-env BUILD_CLIENT=true NODE_ENV=development tsx ./scripts/runDevBuild.ts', {
      cwd: SPX_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH, NODE_ENV: 'development', BUILD_CLIENT: 'true', ...extraEnv },
      timeout: 180_000,
    });
    console.log(`  ✓ ${label} build complete`);
    return true;
  } catch (e) {
    const stderr = e.stderr?.toString().slice(-1000) || '';
    const stdout = e.stdout?.toString().slice(-500) || '';
    console.error(`  ✗ ${label} build failed:`);
    console.error(`  stderr: ${stderr}`);
    if (stdout) console.error(`  stdout (tail): ${stdout}`);
    return false;
  }
}

// Find the build output directory by looking for recently produced JS files
function findBuildDir() {
  // The SPX_CLIENT build framework writes to a Windows-style path on disk
  // Check known locations including the IIS-style path
  const candidates = [
    join(SPX_ROOT, 'C:\\inetpub\\wwwroot\\sc102.local', 'clientCode', 'headless', 'client'),
    join(SPX_ROOT, 'C:\\inetpub\\wwwroot\\sc102.local'),
    'build/clientCode/headless/client',
    'build/clientCode',
    'build',
    'dist/client',
    'dist',
  ];
  for (const candidate of candidates) {
    const dir = candidate.startsWith('/') ? candidate : join(SPX_ROOT, candidate);
    if (existsSync(dir)) {
      const jsFiles = getJSFiles(dir);
      if (jsFiles.length > 0) return dir;
    }
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(72)}`);
console.log('  PHANTOM BENCHMARK: SPX_CLIENT (Rspack)');
console.log(`${'═'.repeat(72)}\n`);

mkdirSync(RESULTS_DIR, { recursive: true });

// Save original config
const originalConfig = readFileSync(CONFIG_PATH, 'utf-8');

// ── Baseline build ───────────────────────────────────────────────────

console.log('[1/2] Baseline build (no phantom)');
if (!buildClient('baseline')) process.exit(1);

const buildDir = findBuildDir();
if (!buildDir) {
  console.error('Could not find build output directory with JS files.');
  console.error('Searching all JS files under build/...');
  try {
    execSync(`find ${SPX_ROOT}/build -name "*.js" -not -name "*.js.map" 2>/dev/null | head -10`, { stdio: 'inherit' });
  } catch {}
  process.exit(1);
}

console.log(`  Output dir: ${buildDir}`);
const baselineFiles = getJSFiles(buildDir);
const baselineTotal = totalSize(baselineFiles);
console.log(`  JS files: ${baselineFiles.length}, Total: ${fmt(baselineTotal)}`);

// The buildDir already points to the client output
const clientFiles = baselineFiles;
const baselineClientTotal = totalSize(clientFiles);
console.log(`  Client JS: ${clientFiles.length} files, ${fmt(baselineClientTotal)}\n`);

// Snapshot baseline client files for comparison
const baselineSnapshot = clientFiles.map(f => ({ ...f }));

// ── Phantom build ────────────────────────────────────────────────────

console.log('[2/2] Phantom build (with phantom-build)');

// Patch the config to add phantom
const phantomImport = `import phantom from '${PHANTOM_ROOT}/dist/rspack.js';\n`;
let patchedConfig = phantomImport + originalConfig;
patchedConfig = patchedConfig.replace(
  /plugins:\s*\[/,
  `plugins: [\n      phantom({ silent: false }),`
);

// Increase maxChunks to allow phantom chunks
patchedConfig = patchedConfig.replace(
  /maxChunks:\s*10/,
  'maxChunks: 100'
);

writeFileSync(CONFIG_PATH, patchedConfig, 'utf-8');

// Clean any prior phantom manifest
const priorManifest = join(SPX_ROOT, 'phantom.manifest.json');
if (existsSync(priorManifest)) rmSync(priorManifest);

let phantomOk = false;
try {
  phantomOk = buildClient('phantom');
} finally {
  // Always restore original config
  writeFileSync(CONFIG_PATH, originalConfig, 'utf-8');
  console.log('  (Config restored)');
}

if (!phantomOk) process.exit(1);

const phantomClientFiles = getJSFiles(buildDir);
const phantomClientTotal = totalSize(phantomClientFiles);
console.log(`  Client JS: ${phantomClientFiles.length} files, ${fmt(phantomClientTotal)}\n`);

// ── Compare ──────────────────────────────────────────────────────────

console.log(`${'═'.repeat(72)}`);
console.log('  RESULTS: Client-side JS comparison');
console.log(`${'═'.repeat(72)}\n`);

console.log(`  ${'Metric'.padEnd(40)} ${'Baseline'.padEnd(14)} ${'Phantom'.padEnd(14)} Change`);
console.log(`  ${'─'.repeat(68)}`);

const sizeChange = phantomClientTotal - baselineClientTotal;
const sizePct = baselineClientTotal > 0 ? ((sizeChange / baselineClientTotal) * 100).toFixed(1) : 'N/A';
const sizeSign = sizeChange <= 0 ? '' : '+';
const fileDiff = phantomClientFiles.length - baselineSnapshot.length;

console.log(`  ${'JS files count'.padEnd(40)} ${String(baselineSnapshot.length).padEnd(14)} ${String(phantomClientFiles.length).padEnd(14)} ${fileDiff > 0 ? '+' : ''}${fileDiff}`);
console.log(`  ${'Total client JS size'.padEnd(40)} ${fmt(baselineClientTotal).padEnd(14)} ${fmt(phantomClientTotal).padEnd(14)} ${sizeSign}${sizePct}%`);

// Find phantom chunks
const phantomChunks = phantomClientFiles.filter(f =>
  f.file.includes('phantom') || f.file.includes('grp_')
);
if (phantomChunks.length > 0) {
  const phantomChunkTotal = totalSize(phantomChunks);
  console.log(`  ${'Phantom on-demand chunks'.padEnd(40)} ${'—'.padEnd(14)} ${fmt(phantomChunkTotal).padEnd(14)} ${phantomChunks.length} chunks`);
}

// Compare matched files (same name in both builds)
const baselineMap = new Map(baselineSnapshot.map(f => [f.file, f.size]));
const phantomMap = new Map(phantomClientFiles.map(f => [f.file, f.size]));

let matchedCount = 0;
let totalSaved = 0;
const changedFiles = [];

for (const [file, bSize] of baselineMap) {
  const pSize = phantomMap.get(file);
  if (pSize !== undefined) {
    matchedCount++;
    const diff = bSize - pSize;
    if (diff !== 0) {
      changedFiles.push({ file, baselineSize: bSize, phantomSize: pSize, saved: diff });
      totalSaved += diff;
    }
  }
}

if (changedFiles.length > 0) {
  changedFiles.sort((a, b) => b.saved - a.saved);
  console.log(`\n  Files with size changes (${changedFiles.length} of ${matchedCount} matched):`);
  console.log(`  ${'File'.padEnd(55)} ${'Baseline'.padEnd(12)} ${'Phantom'.padEnd(12)} Saved`);
  console.log(`  ${'─'.repeat(85)}`);
  for (const f of changedFiles.slice(0, 20)) {
    const name = f.file.replace('website-headless/', '').slice(0, 53);
    const savedStr = f.saved > 0
      ? `${fmt(f.saved)} (−${((f.saved / f.baselineSize) * 100).toFixed(0)}%)`
      : `+${fmt(-f.saved)}`;
    console.log(`  ${name.padEnd(55)} ${fmt(f.baselineSize).padEnd(12)} ${fmt(f.phantomSize).padEnd(12)} ${savedStr}`);
  }
  console.log(`  ${'─'.repeat(85)}`);
  console.log(`  ${'TOTAL saved from matched files'.padEnd(55)} ${fmt(totalSaved)}`);
}

// New files in phantom build (phantom chunks)
const newFiles = phantomClientFiles.filter(f => !baselineMap.has(f.file));
if (newFiles.length > 0) {
  console.log(`\n  New files in phantom build (${newFiles.length}):`);
  for (const f of newFiles.slice(0, 15)) {
    const name = f.file.replace('website-headless/', '').slice(0, 60);
    console.log(`    ${fmt(f.size).padStart(10)}  ${name}`);
  }
}

// Look for manifest
const manifestPath = join(SPX_ROOT, 'phantom.manifest.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const handlers = manifest.entries?.filter(e => e.kind === 'handler').length || 0;
  const lazy = manifest.entries?.filter(e => e.kind === 'lazy').length || 0;
  console.log(`\n  Phantom Manifest:`);
  console.log(`    Handlers extracted: ${handlers}`);
  console.log(`    Components lazified: ${lazy}`);
  console.log(`    Total entries: ${manifest.entries?.length || 0}`);
  console.log(`    Modules processed: ${manifest.stats?.totalModulesProcessed || 0}`);
}

console.log(`\n${'═'.repeat(72)}\n`);

// Save results
writeFileSync(
  join(RESULTS_DIR, 'results.json'),
  JSON.stringify({
    baseline: { files: baselineSnapshot.length, totalBytes: baselineClientTotal },
    phantom: { files: phantomClientFiles.length, totalBytes: phantomClientTotal },
    phantomChunks: phantomChunks.length,
    changedFiles: changedFiles.length,
    totalSaved,
    diff: { bytes: sizeChange, pct: sizePct },
  }, null, 2),
  'utf-8',
);
console.log(`Results saved to ${RESULTS_DIR}/results.json`);
