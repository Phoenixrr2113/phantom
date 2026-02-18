#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeModule } from './analyzer.js';

// ── Argument parsing ─────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: phantom analyze <file> [options]

Analyze a single file and print segment classification details.

Options:
  --threshold <number>   Confidence threshold for extraction (default: 0.8)
  --help, -h             Show this help message
`.trim());
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const command = args[0];
  if (command !== 'analyze') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const filePath = args[1];
  if (!filePath) {
    console.error('Error: No file specified');
    printUsage();
    process.exit(1);
  }

  // Parse --threshold flag
  let threshold = 0.8;
  const thresholdIdx = args.indexOf('--threshold');
  if (thresholdIdx !== -1) {
    const val = parseFloat(args[thresholdIdx + 1]);
    if (isNaN(val) || val < 0 || val > 1) {
      console.error('Error: --threshold must be a number between 0 and 1');
      process.exit(1);
    }
    threshold = val;
  }

  // Read and analyze the file
  const absolutePath = resolve(filePath);
  let code: string;
  try {
    code = readFileSync(absolutePath, 'utf-8');
  } catch {
    console.error(`Error: Cannot read file "${absolutePath}"`);
    process.exit(1);
  }

  const result = analyzeModule(code, absolutePath, { confidenceThreshold: threshold });

  // ── Output ───────────────────────────────────────────────────────

  console.log(`\nPhantom Analysis: ${filePath}`);
  console.log('═'.repeat(60));

  if (result.segments.length === 0) {
    console.log('No classifiable segments found.');
    return;
  }

  // Segment table
  console.log(`\n  ${'Name'.padEnd(30)} ${'Class'.padEnd(20)} ${'Conf'.padEnd(6)} Extracted?`);
  console.log(`  ${'─'.repeat(30)} ${'─'.repeat(20)} ${'─'.repeat(6)} ${'─'.repeat(10)}`);

  for (const seg of result.segments) {
    const extracted = result.chunkModules?.some((m) => m.id === seg.id) ? '✓ yes' : '  no';
    console.log(
      `  ${seg.name.padEnd(30)} ${seg.classification.padEnd(20)} ${seg.confidence.toFixed(2).padStart(5)}  ${extracted}`,
    );
    if (seg.reasons.length > 0) {
      for (const reason of seg.reasons) {
        console.log(`    → ${reason}`);
      }
    }
  }

  // Summary
  console.log('');
  console.log(`  Segments: ${result.segments.length}`);
  console.log(`  Threshold: ${threshold}`);

  if (result.chunkModules && result.chunkModules.length > 0) {
    console.log(`  Chunks extracted: ${result.chunkModules.length}`);
    for (const mod of result.chunkModules) {
      const sizeKb = (Buffer.byteLength(mod.code, 'utf-8') / 1024).toFixed(1);
      console.log(`    ${mod.id} (${sizeKb} KB)`);
    }
  } else {
    console.log('  Chunks extracted: 0');
  }

  console.log('');
}

main();
