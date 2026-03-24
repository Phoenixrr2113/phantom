import type { Node, Program } from 'estree';
import { print } from 'esrap';
import tsx from 'esrap/languages/tsx';
import type { AnalyzedModule, ClassifiedSegment, LazyCandidate, SourceMapLike } from '../types.js';
import { resolveImports } from './import-resolver.js';
import { replaceWithStub, type ExtractableNode } from './client-stub.js';
import { applyLazyTransforms } from './lazy-transform.js';
import { generateGroupedChunkModule, generateGroupId, type GroupedHandlerInput } from './grouped-chunk-module.js';

export interface ExtractionResult {
  clientCode: string;
  clientMap: SourceMapLike;
  chunkModules: Array<{ id: string; code: string; map: SourceMapLike }>;
  /** Individual segment IDs within the grouped module */
  extractedSegmentIds: string[];
}

/**
 * Extract EventHandler segments from a module into lazy-loaded chunks.
 *
 * All handlers from the same source file are grouped into a single chunk module
 * with multiple named exports. This reduces the number of HTTP requests and
 * improves gzip compression compared to one-chunk-per-handler.
 *
 * Returns `null` if no segments qualify for extraction,
 * otherwise returns rewritten client code + chunk modules.
 *
 * Uses proper AST-based codegen with esrap — no source text splicing.
 *
 * @param analyzed - The parsed and scope-analyzed module (provides AST and dependency info).
 * @param segments - Classified segments from {@link classifyModule} to consider for extraction.
 * @param _sourceCode - The original source code (used for source map generation).
 * @param confidenceThreshold - Minimum confidence score (0–1) for a segment to be extracted.
 * @param sourceFilePath - Absolute path to the source file (used for chunk IDs and import resolution).
 * @param lazyCandidates - Optional lazy-loading candidates from `detectLazyCandidates`.
 * @param minHandlerSize - Minimum handler byte size to qualify for extraction (default: 200).
 * @returns An {@link ExtractionResult} with rewritten client code and chunk modules,
 *   or `null` if nothing was extracted.
 *
 * @example
 * const analyzed = parseModule(code, '/src/Form.tsx');
 * const segments = classifyModule(analyzed, code);
 * const result = extractModule(analyzed, segments, code, 0.8, '/src/Form.tsx');
 * if (result) {
 *   // result.clientCode — the rewritten source with lazy stubs
 *   // result.chunkModules — the handler chunk(s) to emit as separate files
 * }
 */
export function extractModule(
  analyzed: AnalyzedModule,
  segments: ClassifiedSegment[],
  _sourceCode: string,
  confidenceThreshold: number,
  sourceFilePath: string,
  lazyCandidates?: LazyCandidate[],
  minHandlerSize: number = 200,
): ExtractionResult | null {
  const extractable = segments.filter(
    (seg) =>
      seg.classification === 'EventHandler' &&
      seg.confidence >= confidenceThreshold &&
      (seg.span.end - seg.span.start) >= minHandlerSize,
  );

  const hasLazyTransforms = lazyCandidates && lazyCandidates.length > 0;

  // Nothing to do if no handler extractions and no lazy transforms
  if (extractable.length === 0 && !hasLazyTransforms) return null;

  // Deep-copy the full AST for client code mutation
  const clientAST = structuredClone(analyzed.ast) as Program;

  // ── Phase 1: Collect handler data for grouping ──────────────────────
  const groupedHandlers: GroupedHandlerInput[] = [];
  const extractedSegmentIds: string[] = [];
  const seenSegmentIds = new Set<string>();

  // Collect data for each handler + replace stubs in client AST
  const groupId = extractable.length > 0 ? generateGroupId(sourceFilePath) : undefined;

  interface PendingStub {
    clientNode: ExtractableNode;
    segment: ClassifiedSegment;
    capturedParams: string[];
  }
  const pendingStubs: PendingStub[] = [];

  for (const segment of extractable) {
    // Find the AST node in the ORIGINAL tree (for chunk module generation)
    const originalNode = findASTNode(analyzed.ast, segment.span);
    if (!originalNode) {
      console.warn(`[phantom] Skipping segment "${segment.id}" — no matching AST node found in original tree (span ${segment.span.start}:${segment.span.end}). This may indicate an AST/span mismatch.`);
      continue;
    }

    // Find the corresponding node in the CLONED tree (for client mutation)
    const clientNode = findASTNode(clientAST, segment.span);
    if (!clientNode) {
      console.warn(`[phantom] Skipping segment "${segment.id}" — no matching AST node found in cloned tree (span ${segment.span.start}:${segment.span.end}). Cloning may have altered node positions.`);
      continue;
    }

    // Separate captured vars from imports (rewrites relative paths to absolute)
    const resolution = resolveImports(segment, analyzed, sourceFilePath);

    // Only include each unique segment ID once in the grouped module
    // (two handlers with identical content hash → same seg ID → would cause duplicate export)
    if (!seenSegmentIds.has(segment.id)) {
      groupedHandlers.push({
        segment,
        astNode: originalNode,
        imports: resolution.imports,
        capturedParams: resolution.capturedParams,
      });
      seenSegmentIds.add(segment.id);
    }

    // All stubs still need replacement (each points to the same function in the grouped module)
    pendingStubs.push({
      clientNode,
      segment,
      capturedParams: resolution.capturedParams,
    });

    extractedSegmentIds.push(segment.id);
  }

  // ── Phase 2: Generate grouped chunk module ──────────────────────────
  const chunkModules: Array<{ id: string; code: string; map: SourceMapLike }> = [];

  if (groupedHandlers.length > 0 && groupId) {
    // Generate the single grouped module containing all handler exports
    const groupedResult = generateGroupedChunkModule(
      groupedHandlers,
      sourceFilePath,
      _sourceCode,
    );
    chunkModules.push({ id: groupId, code: groupedResult.code, map: groupedResult.map });

    // Now replace all handler bodies with lazy stubs pointing to the grouped module
    for (const stub of pendingStubs) {
      replaceWithStub(stub.clientNode, stub.segment, stub.capturedParams, groupId);
    }
  }

  const extractedCount = groupedHandlers.length;

  // Apply React.lazy + Suspense transforms (after handler extraction)
  if (hasLazyTransforms) {
    applyLazyTransforms(clientAST, lazyCandidates!);
  }

  // Bail if neither handler extraction nor lazy transforms produced changes
  if (extractedCount === 0 && !hasLazyTransforms) return null;

  // Prepend `import { $p } from 'phantom-build/runtime'` if handlers were extracted
  if (extractedCount > 0) {
    const lazyImport = {
      type: 'ImportDeclaration' as const,
      specifiers: [{
        type: 'ImportSpecifier' as const,
        imported: { type: 'Identifier' as const, name: '$p' },
        local: { type: 'Identifier' as const, name: '$p' },
      }],
      source: { type: 'Literal' as const, value: 'phantom-build/runtime' },
    };
    clientAST.body.unshift(lazyImport as Program['body'][number]);
  }

  // Generate client code with esrap (including source map)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- esrap tsx visitors expect TSESTree.Node, OXC produces compatible estree nodes
  const result = print(clientAST as any, tsx() as any, {
    sourceMapSource: sourceFilePath,
    sourceMapContent: _sourceCode,
  });

  return { clientCode: result.code, clientMap: result.map, chunkModules, extractedSegmentIds };
}

// ── AST helpers ──────────────────────────────────────────────────────────

function findASTNode(
  root: Node,
  span: { start: number; end: number },
): ExtractableNode | null {
  let match: ExtractableNode | null = null;

  walkNode(root, (node) => {
    const n = node as Node & { start?: number; end?: number };
    if (n.start !== span.start || n.end !== span.end) return;

    if (
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration'
    ) {
      match = node as ExtractableNode;
    }
  });

  return match;
}

function walkNode(node: unknown, callback: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) walkNode(child, callback);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (typeof obj.type !== 'string') return;

  callback(obj as unknown as Node);

  for (const key of Object.keys(obj)) {
    if (key === 'type') continue;
    walkNode(obj[key], callback);
  }
}
