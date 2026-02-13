import type { Node, Program } from 'estree';
import { print } from 'esrap';
import tsx from 'esrap/languages/tsx';
import type { AnalyzedModule, ClassifiedSegment } from '../types.js';
import { resolveImports } from './import-resolver.js';
import { generateServerModule } from './server-module.js';
import { replaceWithStub, type ExtractableNode } from './client-stub.js';

export interface ExtractionResult {
  clientCode: string;
  serverModules: Array<{ id: string; code: string }>;
}

/**
 * Extract ServerCompute segments from a module.
 *
 * Returns null if no segments qualify for extraction,
 * otherwise returns rewritten client code + server modules.
 *
 * Uses proper AST-based codegen with esrap — no source text splicing.
 */
export function extractModule(
  analyzed: AnalyzedModule,
  segments: ClassifiedSegment[],
  _sourceCode: string,
  confidenceThreshold: number,
): ExtractionResult | null {
  const extractable = segments.filter(
    (seg) =>
      seg.classification === 'ServerCompute' &&
      seg.confidence >= confidenceThreshold,
  );

  if (extractable.length === 0) return null;

  // Deep-copy the full AST for client code mutation
  const clientAST = structuredClone(analyzed.ast) as Program;

  const serverModules: Array<{ id: string; code: string }> = [];
  let extractedCount = 0;

  for (const segment of extractable) {
    // Find the AST node in the ORIGINAL tree (for server module generation)
    const originalNode = findASTNode(analyzed.ast, segment.span);
    if (!originalNode) continue;

    // Find the corresponding node in the CLONED tree (for client mutation)
    const clientNode = findASTNode(clientAST, segment.span);
    if (!clientNode) continue;

    // Separate captured vars from imports
    const resolution = resolveImports(segment, analyzed);

    // Generate the server module from the original (unmutated) AST
    const serverCode = generateServerModule(
      segment,
      originalNode,
      resolution.imports,
      resolution.capturedParams,
    );
    serverModules.push({ id: segment.id, code: serverCode });

    // Mutate the client AST node — replace function body with RPC stub
    replaceWithStub(clientNode, segment, resolution.capturedParams);

    extractedCount++;
  }

  if (extractedCount === 0) return null;

  // Prepend `import { __phantom_rpc } from 'phantom-build/runtime'` to the client AST
  const rpcImport = {
    type: 'ImportDeclaration' as const,
    specifiers: [{
      type: 'ImportSpecifier' as const,
      imported: { type: 'Identifier' as const, name: '__phantom_rpc' },
      local: { type: 'Identifier' as const, name: '__phantom_rpc' },
    }],
    source: { type: 'Literal' as const, value: 'phantom-build/runtime' },
  };
  clientAST.body.unshift(rpcImport as Program['body'][number]);

  // Generate client code with esrap
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- esrap tsx visitors expect TSESTree.Node, OXC produces compatible estree nodes
  const result = print(clientAST as any, tsx() as any);

  return { clientCode: result.code, serverModules };
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
