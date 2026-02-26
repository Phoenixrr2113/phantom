import type { ClassifiedSegment, ImportInfo, SourceMapLike } from '../types.js';
import type { ExtractableNode } from './client-stub.js';
import { print } from 'esrap';
import tsx from 'esrap/languages/tsx';
import type {
  BlockStatement,
  FunctionDeclaration,
  Identifier,
  ImportDeclaration,
  ImportDefaultSpecifier,
  ImportNamespaceSpecifier,
  ImportSpecifier,
  Program,
  ReturnStatement,
} from 'estree';

// ── TypeScript stripping ────────────────────────────────────────────────

/**
 * TS wrapper node types that should be unwrapped to their inner expression.
 * These nodes exist in OXC's AST when parsing TypeScript but have no JS equivalent.
 */
const TS_WRAPPER_TYPES = new Set([
  'TSAsExpression',         // `x as Type`
  'TSSatisfiesExpression',  // `x satisfies Type`
  'TSNonNullExpression',    // `x!`
  'TSTypeAssertion',        // `<Type>x`
  'TSInstantiationExpression', // `fn<Type>`
]);

/**
 * Properties that carry TypeScript type information and should be deleted.
 */
const TS_ANNOTATION_PROPS = ['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments'] as const;

/**
 * Recursively strip TypeScript-specific nodes from a cloned ESTree AST.
 *
 * This ensures chunk modules are valid JavaScript even when the source
 * contained TypeScript annotations (e.g., `e.target as HTMLFormElement`).
 *
 * Mutates the tree in place and returns it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripTypeAnnotations(node: any): any {
  if (node == null || typeof node !== 'object') return node;

  // Handle arrays (e.g., body[], params[])
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = stripTypeAnnotations(node[i]);
    }
    return node;
  }

  // Skip non-AST objects (Literal values, etc.)
  if (!node.type) return node;

  // Unwrap TS wrapper nodes to their inner expression
  if (TS_WRAPPER_TYPES.has(node.type)) {
    return stripTypeAnnotations(node.expression);
  }

  // Delete TS annotation properties
  for (const prop of TS_ANNOTATION_PROPS) {
    if (prop in node) {
      delete node[prop];
    }
  }

  // Strip TS-only statement types entirely (type aliases, interfaces, enums, etc.)
  // These shouldn't appear in function bodies, but guard against it
  if (node.type.startsWith('TS') && node.type !== 'TSModuleBlock') {
    return node;
  }

  // Recurse into all properties
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const val = node[key];
    if (val && typeof val === 'object') {
      node[key] = stripTypeAnnotations(val);
    }
  }

  return node;
}

// ── Handler function AST builder (shared between single and grouped) ────

/**
 * Build an exported FunctionDeclaration AST node for a single handler.
 *
 * This is the core logic shared by both `generateChunkModule()` (single handler
 * per file) and `generateGroupedChunkModule()` (multiple handlers per file).
 *
 * Returns an ExportNamedDeclaration wrapping a FunctionDeclaration with the
 * segment ID as the function name. TypeScript annotations are stripped.
 */
export function buildHandlerExportAST(
  segment: ClassifiedSegment,
  astNode: ExtractableNode,
  capturedParams: string[],
): { type: 'ExportNamedDeclaration'; declaration: FunctionDeclaration; specifiers: never[]; source: null; attributes: never[] } {
  const originalParams = stripTypeAnnotations(structuredClone(astNode.params));
  const capturedIdentifiers: Identifier[] = capturedParams.map((name) => ({
    type: 'Identifier',
    name,
  }));
  const params = [...originalParams, ...capturedIdentifiers];

  let fnBody: BlockStatement;

  if (astNode.type === 'ArrowFunctionExpression' && astNode.body.type !== 'BlockStatement') {
    // Expression body: () => expr  →  { return expr; }
    fnBody = stripTypeAnnotations({
      type: 'BlockStatement',
      body: [{ type: 'ReturnStatement', argument: structuredClone(astNode.body) } as ReturnStatement],
    });
  } else if (astNode.type === 'ArrowFunctionExpression' || astNode.type === 'FunctionExpression') {
    fnBody = stripTypeAnnotations(structuredClone(astNode.body)) as BlockStatement;
  } else {
    fnBody = stripTypeAnnotations(structuredClone(astNode.body));
  }

  const funcDecl: FunctionDeclaration = {
    type: 'FunctionDeclaration',
    id: { type: 'Identifier', name: segment.id },
    params,
    body: fnBody,
    async: (astNode as { async?: boolean }).async ?? false,
    generator: (astNode as { generator?: boolean }).generator ?? false,
  };

  return {
    type: 'ExportNamedDeclaration' as const,
    declaration: funcDecl,
    specifiers: [] as never[],
    source: null,
    attributes: [] as never[],
  };
}

/**
 * Build ImportDeclaration AST nodes from an array of ImportInfo.
 */
export function buildImportDeclarations(imports: ImportInfo[]): ImportDeclaration[] {
  return imports.map((imp) => {
    const specifiers: (ImportSpecifier | ImportDefaultSpecifier | ImportNamespaceSpecifier)[] =
      imp.specifiers.map((spec) => {
        if (spec.kind === 'default') {
          return {
            type: 'ImportDefaultSpecifier' as const,
            local: { type: 'Identifier' as const, name: spec.local },
          };
        }
        if (spec.kind === 'namespace') {
          return {
            type: 'ImportNamespaceSpecifier' as const,
            local: { type: 'Identifier' as const, name: spec.local },
          };
        }
        return {
          type: 'ImportSpecifier' as const,
          imported: { type: 'Identifier' as const, name: spec.imported ?? spec.local },
          local: { type: 'Identifier' as const, name: spec.local },
        };
      });

    return {
      type: 'ImportDeclaration',
      specifiers,
      source: { type: 'Literal', value: imp.source },
    } as ImportDeclaration;
  });
}

// ── Chunk module generation ─────────────────────────────────────────────

/**
 * Generate a lazy-loaded chunk module that exports the extracted function.
 *
 * Output shape:
 *
 *   import { someUtil } from './utils';
 *
 *   export function seg_abc123(e) {
 *     e.preventDefault();
 *     const form = e.target;
 *     // ...handler logic
 *   }
 */
export function generateChunkModule(
  segment: ClassifiedSegment,
  astNode: ExtractableNode,
  imports: ImportInfo[],
  capturedParams: string[],
  sourceFilePath: string,
  sourceCode: string,
): { code: string; map: SourceMapLike } {
  const body: Program['body'] = [];

  // 1. Import declarations
  body.push(...buildImportDeclarations(imports));

  // 2. Exported function
  body.push(buildHandlerExportAST(segment, astNode, capturedParams));

  // 3. Generate code with esrap
  const program: Program = {
    type: 'Program',
    sourceType: 'module',
    body,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- esrap tsx visitors expect TSESTree.Node, our estree is compatible at runtime
  const result = print(program as any, tsx() as any, {
    sourceMapSource: sourceFilePath,
    sourceMapContent: sourceCode,
  });
  return { code: result.code, map: result.map };
}
