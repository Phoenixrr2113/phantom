import type { Node, Program } from 'estree';
import { print } from 'esrap';
import tsx from 'esrap/languages/tsx';
import type { AnalyzedModule, ClassifiedSegment, LazyCandidate, SourceMapLike } from '../types.js';
import { resolveImports } from './import-resolver.js';
import { generateChunkModule } from './chunk-module.js';
import { replaceWithStub, type ExtractableNode } from './client-stub.js';
import { applyLazyTransforms } from './lazy-transform.js';

export interface ExtractionResult {
  clientCode: string;
  clientMap: SourceMapLike;
  chunkModules: Array<{ id: string; code: string; map: SourceMapLike }>;
}

/**
 * Extract EventHandler segments from a module into lazy-loaded chunks.
 *
 * Returns null if no segments qualify for extraction,
 * otherwise returns rewritten client code + chunk modules.
 *
 * Uses proper AST-based codegen with esrap — no source text splicing.
 */
export function extractModule(
  analyzed: AnalyzedModule,
  segments: ClassifiedSegment[],
  _sourceCode: string,
  confidenceThreshold: number,
  sourceFilePath: string,
  lazyCandidates?: LazyCandidate[],
): ExtractionResult | null {
  const extractable = segments.filter(
    (seg) =>
      seg.classification === 'EventHandler' &&
      seg.confidence >= confidenceThreshold,
  );

  const hasLazyTransforms = lazyCandidates && lazyCandidates.length > 0;

  // Nothing to do if no handler extractions and no lazy transforms
  if (extractable.length === 0 && !hasLazyTransforms) return null;

  // Deep-copy the full AST for client code mutation
  const clientAST = structuredClone(analyzed.ast) as Program;

  const chunkModules: Array<{ id: string; code: string; map: SourceMapLike }> = [];
  let extractedCount = 0;

  for (const segment of extractable) {
    // Find the AST node in the ORIGINAL tree (for chunk module generation)
    const originalNode = findASTNode(analyzed.ast, segment.span);
    if (!originalNode) continue;

    // Find the corresponding node in the CLONED tree (for client mutation)
    const clientNode = findASTNode(clientAST, segment.span);
    if (!clientNode) continue;

    // Separate captured vars from imports (rewrites relative paths to absolute)
    const resolution = resolveImports(segment, analyzed, sourceFilePath);

    // Generate the chunk module from the original (unmutated) AST
    const chunkResult = generateChunkModule(
      segment,
      originalNode,
      resolution.imports,
      resolution.capturedParams,
      sourceFilePath,
      _sourceCode,
    );
    chunkModules.push({ id: segment.id, code: chunkResult.code, map: chunkResult.map });

    // Mutate the client AST node — replace function body with lazy stub
    replaceWithStub(clientNode, segment, resolution.capturedParams);

    extractedCount++;
  }

  // Apply React.lazy + Suspense transforms (after handler extraction)
  if (hasLazyTransforms) {
    applyLazyTransforms(clientAST, lazyCandidates!);
  }

  // Bail if neither handler extraction nor lazy transforms produced changes
  if (extractedCount === 0 && !hasLazyTransforms) return null;

  // Prepend `import { __phantom_lazy } from 'phantom-build/runtime'` if handlers were extracted
  if (extractedCount > 0) {
    const lazyImport = {
      type: 'ImportDeclaration' as const,
      specifiers: [{
        type: 'ImportSpecifier' as const,
        imported: { type: 'Identifier' as const, name: '__phantom_lazy' },
        local: { type: 'Identifier' as const, name: '__phantom_lazy' },
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

  return { clientCode: result.code, clientMap: result.map, chunkModules };
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
