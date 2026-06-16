#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeModule } from './analyzer.js';
import { analyzeRscReadiness, toJSON, toMarkdown, toTerminal } from './rsc/index.js';
import type { RscReport } from './rsc/types.js';

// ── Argument parsing ─────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: phantom <command> [options]

  Static analysis for React/TypeScript codebases. Classify a single file's
  segments for lazy extraction, or map a whole directory's React Server
  Components readiness.

Commands:
  analyze <file>    Analyze a single .tsx/.ts file for extractable segments
  rsc <dir>         Map a directory's RSC readiness (client frontier, rescues,
                      serialization hazards). Report-only — never writes source.

Options:
  --threshold <0-1>             Confidence threshold for extraction (default: 0.8)
                                  Higher values extract fewer, more certain handlers.
                                  Lower values extract more aggressively.
                                  (analyze only)
  --min-handler-size <bytes>    Minimum handler size in bytes to consider for
                                  extraction (default: 200). Set to 0 to see all
                                  handlers regardless of size. (analyze only)
  --json                        Emit the RSC report as JSON to stdout. (rsc only)
  --markdown <out>              Write a Markdown RSC report to <out>. (rsc only)
  --help, -h                    Show this help message

Examples:
  phantom analyze src/components/Button.tsx
  phantom analyze src/components/Form.tsx --threshold 0.9
  phantom analyze src/components/Modal.tsx --threshold 0.7 --min-handler-size 0
  phantom rsc src/
  phantom rsc src/ --json
  phantom rsc src/ --markdown rsc-report.md

Output columns:
  Name          Handler or component name
  Class         EventHandler | PureComputation | Unknown
  Conf          Confidence score (0.00–1.00)
  Extracted?    Whether the handler will be split into a lazy chunk

Troubleshooting:
  No segments found
    → The file may have no detectable event handlers (onClick, onChange, etc.)
    → Try lowering --threshold or setting --min-handler-size 0

  Unexpected handlers kept static
    → Raise --threshold closer to 1.0 to keep more handlers in the main bundle
    → Handlers using the 'this' keyword or context providers are never extracted

  Parse errors
    → Ensure the file has valid syntax and the extension matches its content
      (.tsx for files with JSX, .ts for plain TypeScript)
`.trim());
}

function runRsc(args: string[]): void {
  const dir = args[1];
  if (!dir || dir.startsWith('-')) {
    console.error('Error: No directory specified for "rsc"');
    printUsage();
    process.exit(1);
  }

  const json = args.includes('--json');
  let markdownOut: string | undefined;
  const mdIdx = args.indexOf('--markdown');
  if (mdIdx !== -1) {
    markdownOut = args[mdIdx + 1];
    if (!markdownOut || markdownOut.startsWith('-')) {
      console.error('Error: --markdown requires an output path');
      process.exit(1);
    }
  }

  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`Error: Directory not found: "${absDir}"`);
    process.exit(1);
  }

  let report: RscReport;
  try {
    report = analyzeRscReadiness(absDir);
  } catch (err) {
    console.error(
      `Error: RSC analysis failed for "${absDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Write markdown to a file if requested (notice goes to stderr so --json stdout stays pure JSON).
  if (markdownOut) {
    writeFileSync(resolve(markdownOut), toMarkdown(report), 'utf-8');
    console.error(`Markdown report written to ${markdownOut}`);
  }

  if (json) {
    console.log(toJSON(report));
  } else {
    console.log(`\nPhantom RSC Readiness: ${dir}`);
    console.log('═'.repeat(60));
    console.log(toTerminal(report));
    console.log('');
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const command = args[0];

  if (command === 'rsc') {
    runRsc(args);
    return;
  }

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
