import type { ClassifiedSegment } from '../types.js';
import type {
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  ExpressionStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  Literal,
  MemberExpression,
  Node,
  Pattern,
} from 'estree';

export type ExtractableNode =
  | ArrowFunctionExpression
  | FunctionExpression
  | FunctionDeclaration;

// ── Synchronous prelude detection ───────────────────────────────────────

/**
 * Event methods that must run synchronously during event dispatch.
 * If the handler calls these on its first parameter, the stub must
 * call them BEFORE the async $p() invocation.
 */
const SYNC_EVENT_METHODS = new Set([
  'preventDefault',
  'stopPropagation',
  'stopImmediatePropagation',
]);

/**
 * Detect synchronous event method calls in the handler body.
 *
 * Walks the AST looking for `e.preventDefault()`, `e.stopPropagation()`, etc.
 * where `e` is the first parameter of the function.
 *
 * Returns deduplicated list of method names that need to be hoisted.
 */
function detectSyncEventCalls(astNode: ExtractableNode): string[] {
  const firstParam = astNode.params[0];
  if (!firstParam) return [];

  // Extract the param name from Identifier or AssignmentPattern (default value)
  // e.g., (e) => ... or (e = defaultEvent) => ...
  // Destructured params ({target}) can't call e.preventDefault() — skip them.
  let paramName: string | null = null;
  if (firstParam.type === 'Identifier') {
    paramName = firstParam.name;
  } else if (firstParam.type === 'AssignmentPattern' && firstParam.left.type === 'Identifier') {
    paramName = firstParam.left.name;
  }
  if (!paramName) return [];

  const found = new Set<string>();

  walkNode(astNode.body as unknown as Node, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = (node as unknown as CallExpression).callee;
    if (callee.type !== 'MemberExpression') return;
    const member = callee as MemberExpression;
    if (member.object.type !== 'Identifier' || (member.object as Identifier).name !== paramName) return;
    if (member.property.type !== 'Identifier') return;
    const methodName = (member.property as Identifier).name;
    if (SYNC_EVENT_METHODS.has(methodName)) {
      found.add(methodName);
    }
  });

  return [...found];
}

/**
 * Build AST nodes for the synchronous prelude.
 *
 * Generates:
 *   e.preventDefault();       // only if detected
 *   e.stopPropagation();      // only if detected
 *   e.persist?.();            // always when handler has event param
 */
function buildPrelude(
  paramName: string,
  syncMethods: string[],
): ExpressionStatement[] {
  const stmts: ExpressionStatement[] = [];

  // Hoist detected sync methods
  for (const method of syncMethods) {
    stmts.push({
      type: 'ExpressionStatement',
      expression: {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: { type: 'Identifier', name: paramName } as Identifier,
          property: { type: 'Identifier', name: method } as Identifier,
          computed: false,
          optional: false,
        } as MemberExpression,
        arguments: [],
        optional: false,
      } as CallExpression,
    });
  }

  return stmts;
}

// ── Param name extraction ───────────────────────────────────────────────

/**
 * Extract parameter names from the original function's params.
 * Handles simple Identifier params and destructuring patterns (uses rest name or fallback).
 */
function extractParamNames(params: Pattern[]): string[] {
  return params.map((p, i) => {
    if (p.type === 'Identifier') return p.name;
    // For destructured/rest/default patterns, use the pattern directly
    // The chunk module gets the original params via structuredClone
    if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') return p.left.name;
    if (p.type === 'RestElement' && p.argument.type === 'Identifier') return p.argument.name;
    return `__arg${i}`;
  });
}

// ── Stub generation ─────────────────────────────────────────────────────

/**
 * Replace the function body with a $p() call + synchronous prelude.
 *
 * Mutates the AST node in place.
 *
 * If the original handler calls preventDefault()/stopPropagation() on its
 * first param, those calls are hoisted into the synchronous stub so they
 * execute immediately during event dispatch (before the async import).
 *
 * Output shapes:
 *
 *   Arrow (no prelude):
 *     (e) => $p('seg_xxx', e, ...captured)
 *
 *   Arrow (with prelude):
 *     (e) => { e.preventDefault(); e.persist?.(); $p('seg_xxx', e, ...captured); }
 *
 *   FunctionExpression / FunctionDeclaration (always block body):
 *     function f(e) { e.preventDefault(); e.persist?.(); $p('seg_xxx', e, ...captured); }
 */
export function replaceWithStub(
  astNode: ExtractableNode,
  segment: ClassifiedSegment,
  capturedParams: string[],
  groupedModuleId?: string,
): void {
  const originalParamNames = extractParamNames(astNode.params);

  // Detect sync event calls BEFORE mutating the node
  const syncMethods = detectSyncEventCalls(astNode);

  // Build the import factory: () => import('phantom:grp_xxx.js') or () => import('phantom:seg_xxx.chunk.js')
  // This MUST be a static dynamic import so Rollup/Vite can analyze it
  // and emit the chunk as a separate file for code-splitting.
  const importPath = groupedModuleId
    ? `phantom:${groupedModuleId}.js`
    : `phantom:${segment.id}.chunk.js`;
  const importFactory: ArrowFunctionExpression = {
    type: 'ArrowFunctionExpression',
    params: [],
    body: {
      type: 'ImportExpression',
      source: { type: 'Literal', value: importPath } as Literal,
    } as unknown as CallExpression, // ImportExpression is ESTree but not in estree types
    expression: true,
    async: false,
    generator: false,
  };

  const lazyCall: CallExpression = {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: '$p' } as Identifier,
    arguments: [
      importFactory as unknown as Identifier, // factory is first arg
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

  // Build synchronous prelude only when sync event methods were detected.
  // React 17+ removed SyntheticEvent pooling, so persist() is no longer needed.
  const firstParamName = originalParamNames[0];
  const hasPrelude = syncMethods.length > 0 && !!firstParamName;
  const preludeStmts = hasPrelude
    ? buildPrelude(firstParamName, syncMethods)
    : [];

  // The lazy call as a statement (event handlers return void)
  const lazyStmt: ExpressionStatement = {
    type: 'ExpressionStatement',
    expression: lazyCall,
  };

  if (hasPrelude || astNode.type === 'FunctionExpression' || astNode.type === 'FunctionDeclaration') {
    // Block body: { prelude...; $p(...); }
    const blockBody: BlockStatement = {
      type: 'BlockStatement',
      body: [...preludeStmts, lazyStmt],
    };
    astNode.body = blockBody;
    astNode.params = stubParams;

    // Fix ESTree `expression` property for arrows converted to block body
    if (astNode.type === 'ArrowFunctionExpression') {
      (astNode as ArrowFunctionExpression).expression = false;
    }

    // Strip TS-specific properties that survive from the original node
    // (the client code is TSX so esrap handles them, but clean up for correctness)
    if ('returnType' in astNode) delete (astNode as Record<string, unknown>).returnType;
  } else {
    // ArrowFunctionExpression without prelude: expression body
    // (e) => $p(...)
    (astNode as unknown as { body: CallExpression }).body = lazyCall;
    (astNode as ArrowFunctionExpression).expression = true;
    astNode.params = stubParams;
    if ('returnType' in astNode) delete (astNode as Record<string, unknown>).returnType;
  }
}

// ── AST walker ──────────────────────────────────────────────────────────

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
