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
  --threshold <number>          Confidence threshold for extraction (default: 0.8)
  --min-handler-size <number>   Min handler bytes to extract (default: 200)
  --help, -h                    Show this help message
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

  // Parse --min-handler-size flag
  let minHandlerSize: number | undefined;
  const minSizeIdx = args.indexOf('--min-handler-size');
  if (minSizeIdx !== -1) {
    const val = parseInt(args[minSizeIdx + 1], 10);
    if (isNaN(val) || val < 0) {
      console.error('Error: --min-handler-size must be a non-negative integer');
      process.exit(1);
    }
    minHandlerSize = val;
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

  const result = analyzeModule(code, absolutePath, { confidenceThreshold: threshold, minHandlerSize });

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
    const extracted = result.extractedSegmentIds?.includes(seg.id) ? '✓ yes' : '  no';
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

  const extractedCount = result.extractedSegmentIds?.length ?? 0;
  if (extractedCount > 0) {
    console.log(`  Chunks extracted: ${extractedCount}`);
    if (result.chunkModules) {
      for (const mod of result.chunkModules) {
        const sizeKb = (Buffer.byteLength(mod.code, 'utf-8') / 1024).toFixed(1);
        console.log(`    ${mod.id} (${sizeKb} KB)`);
      }
    }
  } else {
    console.log('  Chunks extracted: 0');
  }

  // Lazy component candidates
  if (result.lazyCandidates && result.lazyCandidates.length > 0) {
    console.log(`\n  Lazy Components:`);
    console.log(`  ${'Name'.padEnd(25)} ${'Strategy'.padEnd(12)} Group`);
    console.log(`  ${'─'.repeat(25)} ${'─'.repeat(12)} ${'─'.repeat(15)}`);
    for (const lc of result.lazyCandidates) {
      console.log(
        `  ${lc.localName.padEnd(25)} ${lc.prefetch.padEnd(12)} ${lc.suspenseGroup ?? '(solo)'}`,
      );
      console.log(`    → ${lc.reason}`);
    }
  }

  if (result.lazyKeptStatic && result.lazyKeptStatic.length > 0) {
    console.log(`\n  Kept Static:`);
    for (const ks of result.lazyKeptStatic) {
      console.log(`    ${ks.localName.padEnd(25)} → ${ks.reason}`);
    }
  }

  console.log('');
}

main();
