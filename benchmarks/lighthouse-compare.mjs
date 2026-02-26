#!/usr/bin/env node
/**
 * Lighthouse A/B comparison: baseline vs phantom
 *
 * Runs Lighthouse with simulated throttling (slow 4G + 4x CPU slowdown)
 * on both builds of shadcn-admin and compares key Web Vitals.
 *
 * Usage:
 *   node lighthouse-compare.mjs              # 3 runs each (default)
 *   node lighthouse-compare.mjs --runs=5     # 5 runs each for more stable results
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PHANTOM_ROOT = resolve(ROOT, '..');
const SHADCN_DIR = join(ROOT, 'shadcn-admin');
const CONFIG_PATH = join(SHADCN_DIR, 'vite.config.ts');
const RESULTS_DIR = join(ROOT, 'lighthouse-results');

const RUNS = parseInt(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] || '3');

// Minimal 1×1 PNG (70 bytes) used as placeholder for missing avatar images.
// Without these, `serve -s` returns index.html (~2.4KB) for every missing
// image, inflating Lighthouse's totalByteWeight metric.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64',
);

/** Ensure placeholder avatar images exist in a dist directory. */
function ensureAvatarPlaceholders(distDir) {
  const avatarDir = join(distDir, 'avatars');
  mkdirSync(avatarDir, { recursive: true });
  for (const name of ['01.png', '02.png', '03.png', '04.png', '05.png']) {
    const p = join(avatarDir, name);
    if (!existsSync(p)) writeFileSync(p, TINY_PNG);
  }
  // shadcn.jpg referenced in some components
  const jpg = join(avatarDir, 'shadcn.jpg');
  if (!existsSync(jpg)) writeFileSync(jpg, TINY_PNG);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer(distDir, port) {
  const server = spawn('npx', ['serve', distDir, '-l', String(port), '-s'], {
    stdio: 'pipe',
    detached: false,
  });
  return server;
}

function buildBaseline() {
  console.log('  Building baseline...');
  const distDir = join(SHADCN_DIR, 'dist-baseline');
  if (existsSync(distDir)) { ensureAvatarPlaceholders(distDir); return distDir; }

  const dist = join(SHADCN_DIR, 'dist');
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });

  execSync('npx vite build', {
    cwd: SHADCN_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 120_000,
  });

  execSync(`cp -r "${dist}" "${distDir}"`);
  ensureAvatarPlaceholders(distDir);
  return distDir;
}

function buildPhantom() {
  console.log('  Building with phantom...');
  const distDir = join(SHADCN_DIR, 'dist-phantom');
  if (existsSync(distDir)) { ensureAvatarPlaceholders(distDir); return distDir; }

  const original = readFileSync(CONFIG_PATH, 'utf-8');
  let config = `import phantom from '${PHANTOM_ROOT}/dist/vite.js';\n` + original;
  config = config.replace(/plugins:\s*\[/, 'plugins: [\n    phantom({ silent: true }),');

  writeFileSync(CONFIG_PATH, config, 'utf-8');

  const dist = join(SHADCN_DIR, 'dist');
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  const mp = join(SHADCN_DIR, 'phantom.manifest.json');
  if (existsSync(mp)) rmSync(mp);

  try {
    execSync('npx vite build', {
      cwd: SHADCN_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 120_000,
    });
  } finally {
    writeFileSync(CONFIG_PATH, original, 'utf-8');
  }

  execSync(`cp -r "${dist}" "${distDir}"`);
  ensureAvatarPlaceholders(distDir);
  return distDir;
}

function runLighthouse(url, outputPath) {
  const result = execSync(
    `npx lighthouse "${url}" ` +
    `--output=json ` +
    `--output-path="${outputPath}" ` +
    `--chrome-flags="--headless --no-sandbox" ` +
    `--only-categories=performance ` +
    `--throttling-method=simulate ` +
    `--quiet`,
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      env: { ...process.env },
    }
  );
  return JSON.parse(readFileSync(outputPath, 'utf-8'));
}

function extractMetrics(lhr) {
  const audits = lhr.audits;
  return {
    performanceScore: Math.round((lhr.categories?.performance?.score || 0) * 100),
    FCP: audits['first-contentful-paint']?.numericValue || 0,
    LCP: audits['largest-contentful-paint']?.numericValue || 0,
    TBT: audits['total-blocking-time']?.numericValue || 0,
    CLS: audits['cumulative-layout-shift']?.numericValue || 0,
    SI: audits['speed-index']?.numericValue || 0,
    TTI: audits['interactive']?.numericValue || 0,
    totalByteWeight: audits['total-byte-weight']?.numericValue || 0,
    bootupTime: audits['bootup-time']?.numericValue || 0,
    mainThreadWork: audits['mainthread-work-breakdown']?.numericValue || 0,
  };
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function pctChange(baseline, phantom) {
  if (baseline === 0) return '—';
  const change = ((phantom - baseline) / baseline) * 100;
  const sign = change <= 0 ? '' : '+';
  return `${sign}${change.toFixed(1)}%`;
}

// ── Main ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(72)}`);
console.log('  LIGHTHOUSE A/B COMPARISON: shadcn-admin');
console.log(`  ${RUNS} runs per build · Simulated throttling (slow 4G + 4× CPU)`);
console.log(`${'═'.repeat(72)}\n`);

// Build both versions
const baselineDir = buildBaseline();
const phantomDir = buildPhantom();

mkdirSync(RESULTS_DIR, { recursive: true });

// Run lighthouse for each build
const configs = [
  { name: 'baseline', distDir: baselineDir, port: 4001 },
  { name: 'phantom', distDir: phantomDir, port: 4002 },
];

const allResults = {};

for (const cfg of configs) {
  console.log(`\n  Running Lighthouse on ${cfg.name} (${RUNS} runs)...`);
  const server = startServer(cfg.distDir, cfg.port);
  await sleep(2000); // wait for server to start

  const runs = [];

  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`    Run ${i + 1}/${RUNS}...`);
    const outPath = join(RESULTS_DIR, `${cfg.name}-run${i + 1}.json`);
    try {
      const lhr = runLighthouse(`http://localhost:${cfg.port}`, outPath);
      const metrics = extractMetrics(lhr);
      runs.push(metrics);
      process.stdout.write(` score=${metrics.performanceScore}, TBT=${fmt(metrics.TBT)}\n`);
    } catch (e) {
      process.stdout.write(` FAILED: ${e.message?.slice(0, 80)}\n`);
    }
  }

  server.kill();
  await sleep(500);

  // Compute medians
  if (runs.length > 0) {
    const medians = {};
    for (const key of Object.keys(runs[0])) {
      medians[key] = median(runs.map(r => r[key]));
    }
    allResults[cfg.name] = { runs, medians };
  }
}

// ── Print comparison ────────────────────────────────────────────────────

if (allResults.baseline && allResults.phantom) {
  const b = allResults.baseline.medians;
  const p = allResults.phantom.medians;

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  RESULTS (median of ${RUNS} runs)');
  console.log(`${'═'.repeat(72)}\n`);

  const rows = [
    ['Performance Score', `${b.performanceScore}`, `${p.performanceScore}`, pctChange(b.performanceScore, p.performanceScore)],
    ['First Contentful Paint', fmt(b.FCP), fmt(p.FCP), pctChange(b.FCP, p.FCP)],
    ['Largest Contentful Paint', fmt(b.LCP), fmt(p.LCP), pctChange(b.LCP, p.LCP)],
    ['Speed Index', fmt(b.SI), fmt(p.SI), pctChange(b.SI, p.SI)],
    ['Time to Interactive', fmt(b.TTI), fmt(p.TTI), pctChange(b.TTI, p.TTI)],
    ['Total Blocking Time', fmt(b.TBT), fmt(p.TBT), pctChange(b.TBT, p.TBT)],
    ['Cumulative Layout Shift', b.CLS.toFixed(3), p.CLS.toFixed(3), pctChange(b.CLS, p.CLS)],
    ['', '', '', ''],
    ['JS Boot-up Time', fmt(b.bootupTime), fmt(p.bootupTime), pctChange(b.bootupTime, p.bootupTime)],
    ['Main Thread Work', fmt(b.mainThreadWork), fmt(p.mainThreadWork), pctChange(b.mainThreadWork, p.mainThreadWork)],
    ['Total Byte Weight', fmtBytes(b.totalByteWeight), fmtBytes(p.totalByteWeight), pctChange(b.totalByteWeight, p.totalByteWeight)],
  ];

  console.log(`  ${'Metric'.padEnd(28)} ${'Baseline'.padEnd(14)} ${'Phantom'.padEnd(14)} Change`);
  console.log(`  ${'─'.repeat(66)}`);

  for (const [label, bVal, pVal, change] of rows) {
    if (!label) {
      console.log('');
      continue;
    }
    console.log(`  ${label.padEnd(28)} ${bVal.padEnd(14)} ${pVal.padEnd(14)} ${change}`);
  }

  console.log(`\n${'═'.repeat(72)}`);

  // Highlight the key insight
  const tbtDiff = b.TBT - p.TBT;
  if (tbtDiff > 0) {
    console.log(`  ⚡ Total Blocking Time reduced by ${fmt(tbtDiff)} (${pctChange(b.TBT, p.TBT)})`);
    console.log(`     This is time the main thread was blocked from responding to user input.`);
  }
  const ttiDiff = b.TTI - p.TTI;
  if (ttiDiff > 0) {
    console.log(`  ⚡ Time to Interactive reduced by ${fmt(ttiDiff)} (${pctChange(b.TTI, p.TTI)})`);
    console.log(`     This is how long until the page reliably responds to user input.`);
  }
  console.log(`${'═'.repeat(72)}\n`);

  // Save summary
  writeFileSync(
    join(RESULTS_DIR, 'summary.json'),
    JSON.stringify({ runs: RUNS, baseline: allResults.baseline, phantom: allResults.phantom }, null, 2),
    'utf-8',
  );
  console.log(`  Full results saved to ${RESULTS_DIR}/summary.json\n`);
}
