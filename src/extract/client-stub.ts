import type { ClassifiedSegment } from '../types.js';
import type {
  ArrowFunctionExpression,
  CallExpression,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  Literal,
  Pattern,
  ReturnStatement,
} from 'estree';

export type ExtractableNode =
  | ArrowFunctionExpression
  | FunctionExpression
  | FunctionDeclaration;

/**
 * Extract parameter names from the original function's params.
 * Handles simple Identifier params and destructuring patterns (uses rest name or fallback).
 */
function extractParamNames(params: Pattern[]): string[] {
  return params.map((p, i) => {
    if (p.type === 'Identifier') return p.name;
    // For destructured/rest/default patterns, use the pattern directly
    // The server module gets the original params via structuredClone
    if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') return p.left.name;
    if (p.type === 'RestElement' && p.argument.type === 'Identifier') return p.argument.name;
    return `__arg${i}`;
  });
}

/**
 * Replace the function body with a __phantom_rpc() call.
 *
 * Mutates the AST node in place. The RPC call passes both the function's
 * original parameters and captured variables from the outer scope.
 *
 *   Arrow / FunctionExpression  →  (...params) => __phantom_rpc('seg_xxx', ...params, ...captured)
 *   FunctionDeclaration         →  function f(...params) { return __phantom_rpc('seg_xxx', ...params, ...captured); }
 */
export function replaceWithStub(
  astNode: ExtractableNode,
  segment: ClassifiedSegment,
  capturedParams: string[],
): void {
  const originalParamNames = extractParamNames(astNode.params);

  const rpcCall: CallExpression = {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: '__phantom_rpc' } as Identifier,
    arguments: [
      { type: 'Literal', value: segment.id } as Literal,
      ...originalParamNames.map(
        (name) => ({ type: 'Identifier', name }) as Identifier,
      ),
      ...capturedParams.map(
        (name) => ({ type: 'Identifier', name }) as Identifier,
      ),
    ],
    optional: false,
  };

  // Build simple Identifier params for the stub (original param names only)
  const stubParams: Identifier[] = originalParamNames.map((name) => ({
    type: 'Identifier',
    name,
  }));

  if (
    astNode.type === 'ArrowFunctionExpression' ||
    astNode.type === 'FunctionExpression'
  ) {
    // Set body to the expression directly (arrow with no braces)
    (astNode as unknown as { body: CallExpression }).body = rpcCall;
    astNode.params = stubParams;
  } else {
    // FunctionDeclaration: wrap in return statement
    const returnStmt: ReturnStatement = {
      type: 'ReturnStatement',
      argument: rpcCall,
    };
    astNode.body = { type: 'BlockStatement', body: [returnStmt] };
    astNode.params = stubParams;
  }
}
