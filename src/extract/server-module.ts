import type { ClassifiedSegment, ImportInfo } from '../types.js';
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

/**
 * Generate a server module that exports the extracted function.
 *
 * Output shape:
 *
 *   import { someUtil } from './utils';
 *
 *   export function seg_abc123(products) {
 *     return products.filter(p => p.inStock).sort(...);
 *   }
 */
export function generateServerModule(
  segment: ClassifiedSegment,
  astNode: ExtractableNode,
  imports: ImportInfo[],
  capturedParams: string[],
): string {
  const body: Program['body'] = [];

  // 1. Import declarations
  for (const imp of imports) {
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

    const decl = {
      type: 'ImportDeclaration',
      specifiers,
      source: { type: 'Literal', value: imp.source },
    } as ImportDeclaration;
    body.push(decl);
  }

  // 2. Exported function with original params + captured params
  // Original function params come first, then captured variables from outer scope
  const originalParams = structuredClone(astNode.params);
  const capturedIdentifiers: Identifier[] = capturedParams.map((name) => ({
    type: 'Identifier',
    name,
  }));
  const params = [...originalParams, ...capturedIdentifiers];

  let fnBody: BlockStatement;

  if (astNode.type === 'ArrowFunctionExpression' && astNode.body.type !== 'BlockStatement') {
    // Expression body: () => expr  →  { return expr; }
    fnBody = {
      type: 'BlockStatement',
      body: [{ type: 'ReturnStatement', argument: structuredClone(astNode.body) } as ReturnStatement],
    };
  } else if (astNode.type === 'ArrowFunctionExpression' || astNode.type === 'FunctionExpression') {
    fnBody = structuredClone(astNode.body) as BlockStatement;
  } else {
    fnBody = structuredClone(astNode.body);
  }

  const funcDecl: FunctionDeclaration = {
    type: 'FunctionDeclaration',
    id: { type: 'Identifier', name: segment.id },
    params,
    body: fnBody,
    async: (astNode as { async?: boolean }).async ?? false,
    generator: (astNode as { generator?: boolean }).generator ?? false,
  };

  const exportDecl = {
    type: 'ExportNamedDeclaration' as const,
    declaration: funcDecl,
    specifiers: [] as never[],
    source: null,
    attributes: [],
  };

  body.push(exportDecl);

  // 3. Generate code with esrap
  const program: Program = {
    type: 'Program',
    sourceType: 'module',
    body,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- esrap tsx visitors expect TSESTree.Node, our estree is compatible at runtime
  const result = print(program as any, tsx() as any);
  return result.code;
}
