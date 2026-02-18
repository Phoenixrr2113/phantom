import type { Node, CallExpression, Identifier } from 'estree';
import type { AnalyzedModule, ClassifiedSegment, FunctionDependency } from '../types.js';
import { analyzeTaint, propagateTaint, type TaintResult } from './taint.js';
import { analyzePurity } from './purity.js';
import { classifySegment } from './boundary.js';
import { EXTRACTABLE_HOOKS, CLIENT_ONLY_HOOKS, EVENT_HANDLER_PROPS } from './react-patterns.js';

/**
 * Run the full 3-pass classification on an analyzed module.
 *
 * Pass 1: Taint analysis — mark functions that reference browser APIs
 * Pass 2: Purity analysis — determine if non-tainted functions are pure
 * Pass 3: Boundary detection — classify and identify extraction candidates
 */
export function classifyModule(
  analyzed: AnalyzedModule,
  sourceCode: string,
): ClassifiedSegment[] {
  const { functions } = analyzed;
  if (functions.length === 0) return [];

  // Pass 1: Taint analysis
  const taintResults = new Map<FunctionDependency, TaintResult>();
  for (const fn of functions) {
    taintResults.set(fn, analyzeTaint(fn));
  }

  // Propagate taint through call chains
  propagateTaint(functions, taintResults);

  // Determine parent hook context for each function
  const hookContexts = detectHookContexts(analyzed, sourceCode);

  // Detect event handler contexts from JSX
  const eventHandlerContexts = detectEventHandlerContexts(analyzed);

  // Build span → AST node map for JSX detection
  const astNodes = buildAstNodeMap(analyzed);

  // Pass 2 + 3: Purity analysis + boundary detection
  const segments: ClassifiedSegment[] = [];
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const taint = taintResults.get(fn)!;
    const purity = analyzePurity(fn, taint);
    const parentHook = hookContexts.get(fn) ?? null;
    const parentEventProp = eventHandlerContexts.get(fn) ?? null;
    const astNode = astNodes.get(`${fn.span.start}:${fn.span.end}`) ?? null;

    const segment = classifySegment({
      fn,
      taint,
      purity,
      parentHook,
      parentEventProp,
      sourceCode,
      filePath: analyzed.path,
      index: i,
      astNode,
    });

    segments.push(segment);
  }

  return segments;
}

/**
 * Build a map from span key to AST node for all function nodes.
 * Used to pass AST nodes to the boundary classifier for JSX detection.
 */
function buildAstNodeMap(
  analyzed: AnalyzedModule,
): Map<string, Node> {
  const nodeMap = new Map<string, Node>();

  walkNode(analyzed.ast, (node) => {
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const start = (node as Node & { start?: number }).start;
      const end = (node as Node & { end?: number }).end;
      if (start != null && end != null) {
        nodeMap.set(`${start}:${end}`, node);
      }
    }
  });

  return nodeMap;
}

/**
 * Detect which functions are callbacks of React hooks.
 *
 * Walks the AST looking for call expressions like:
 *   useMemo(() => ..., [deps])
 *   useEffect(() => ..., [deps])
 *
 * Maps the callback function to its parent hook name.
 */
function detectHookContexts(
  analyzed: AnalyzedModule,
  sourceCode: string,
): Map<FunctionDependency, string> {
  const hookContexts = new Map<FunctionDependency, string>();
  const hookNames = new Set([...EXTRACTABLE_HOOKS, ...CLIENT_ONLY_HOOKS]);

  // Walk AST to find hook calls
  walkNode(analyzed.ast, (node) => {
    if (node.type !== 'CallExpression') return;

    const call = node as CallExpression;
    const callee = call.callee;

    // Resolve hook name from callee
    let hookName: string | null = null;

    if (callee.type === 'Identifier') {
      // Direct call: useMemo(...)
      const name = (callee as Identifier).name;
      if (hookNames.has(name)) hookName = name;
    } else if (callee.type === 'MemberExpression') {
      // Namespace call: React.useMemo(...)
      const prop = (callee as { property: Node }).property;
      if (prop.type === 'Identifier') {
        const name = (prop as Identifier).name;
        if (hookNames.has(name)) hookName = name;
      }
    }

    if (!hookName) return;

    // First argument should be the callback
    const firstArg = call.arguments[0];
    if (
      !firstArg ||
      (firstArg.type !== 'ArrowFunctionExpression' &&
        firstArg.type !== 'FunctionExpression')
    ) {
      return;
    }

    // Find the matching FunctionDependency by span
    const argStart = (firstArg as Node & { start?: number }).start;
    const argEnd = (firstArg as Node & { end?: number }).end;

    if (argStart == null || argEnd == null) return;

    const matchingFn = analyzed.functions.find(
      (fn) => fn.span.start === argStart && fn.span.end === argEnd,
    );

    if (matchingFn) {
      hookContexts.set(matchingFn, hookName);
    }
  });

  return hookContexts;
}

/**
 * Detect which functions are used exclusively as JSX event handler props.
 *
 * Walks the AST looking for JSX attributes like:
 *   onClick={handleClick}
 *   onSubmit={(e) => { ... }}
 *
 * For identifier references (onClick={handleClick}), also traces through
 * useCallback: if `handleClick = useCallback(fn, deps)`, marks the inner
 * callback `fn` as the extraction target.
 *
 * Only marks a function as an event handler if ALL its references in the
 * module are as JSX event handler props (exclusive-use check).
 */
function detectEventHandlerContexts(
  analyzed: AnalyzedModule,
): Map<FunctionDependency, string> {
  const result = new Map<FunctionDependency, string>();

  // Step 1: Collect all event handler references from JSX
  // Maps function name → event prop name (for identifier references)
  const eventHandlerNames = new Map<string, string>();
  // Maps span key → event prop name (for inline function references)
  const eventHandlerSpans = new Map<string, string>();

  // Also build a map from useCallback result names to inner callback FunctionDependency
  // useCallback(fn, deps) → the variable holding the result maps to fn's inner callback
  const useCallbackMap = new Map<string, FunctionDependency>();

  // Detect useCallback patterns: const handler = useCallback(fn, deps)
  walkNode(analyzed.ast, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const decl = node as Node & { id?: Node; init?: Node };
    if (!decl.id || decl.id.type !== 'Identifier') return;
    if (!decl.init || decl.init.type !== 'CallExpression') return;

    const call = decl.init as CallExpression;
    const callee = call.callee;

    let isUseCallback = false;
    if (callee.type === 'Identifier' && (callee as Identifier).name === 'useCallback') {
      isUseCallback = true;
    } else if (callee.type === 'MemberExpression') {
      const prop = (callee as { property: Node }).property;
      if (prop.type === 'Identifier' && (prop as Identifier).name === 'useCallback') {
        isUseCallback = true;
      }
    }

    if (!isUseCallback) return;

    const firstArg = call.arguments[0];
    if (
      !firstArg ||
      (firstArg.type !== 'ArrowFunctionExpression' && firstArg.type !== 'FunctionExpression')
    ) {
      return;
    }

    const argStart = (firstArg as Node & { start?: number }).start;
    const argEnd = (firstArg as Node & { end?: number }).end;
    if (argStart == null || argEnd == null) return;

    const matchingFn = analyzed.functions.find(
      (fn) => fn.span.start === argStart && fn.span.end === argEnd,
    );

    if (matchingFn) {
      useCallbackMap.set((decl.id as Identifier).name, matchingFn);
    }
  });

  // Walk JSX to find event handler props
  walkNode(analyzed.ast, (node) => {
    if ((node.type as string) !== 'JSXAttribute') return;

    const attr = node as unknown as {
      name: { type: string; name?: string };
      value: Node | null;
    };

    // Check if this is an event handler prop
    const propName = attr.name?.name;
    if (!propName || !EVENT_HANDLER_PROPS.has(propName)) return;

    const value = attr.value;
    if (!value || (value.type as string) !== 'JSXExpressionContainer') return;

    const container = value as unknown as { expression: Node };
    const expr = container.expression;

    if (expr.type === 'Identifier') {
      // onClick={handleClick} → record the identifier name
      eventHandlerNames.set((expr as Identifier).name, propName);
    } else if (
      expr.type === 'ArrowFunctionExpression' ||
      expr.type === 'FunctionExpression'
    ) {
      // onClick={() => ...} → record by span
      const start = (expr as Node & { start?: number }).start;
      const end = (expr as Node & { end?: number }).end;
      if (start != null && end != null) {
        eventHandlerSpans.set(`${start}:${end}`, propName);
      }
    }
    // CallExpression → skip (e.g., onClick={createHandler()})
  });

  // Step 2: Count total references to each name in the module for exclusive-use check
  const totalRefs = new Map<string, number>();
  walkNode(analyzed.ast, (node) => {
    if (node.type === 'Identifier') {
      const name = (node as Identifier).name;
      totalRefs.set(name, (totalRefs.get(name) ?? 0) + 1);
    }
  });

  // Count event handler references per name
  const eventRefs = new Map<string, number>();
  for (const [name] of eventHandlerNames) {
    eventRefs.set(name, (eventRefs.get(name) ?? 0) + 1);
  }

  // Step 3: Match to FunctionDependency entries
  // Handle inline functions (matched by span)
  for (const fn of analyzed.functions) {
    const spanKey = `${fn.span.start}:${fn.span.end}`;
    const propName = eventHandlerSpans.get(spanKey);
    if (propName) {
      // Inline functions are always exclusively used as event handlers
      result.set(fn, propName);
      continue;
    }
  }

  // Handle identifier references (matched by name)
  for (const [handlerName, propName] of eventHandlerNames) {
    // Exclusive-use check: the handler name should only appear in JSX event props
    // We approximate this: total refs should be ≤ eventRefs + 1 (the declaration itself)
    // If it's referenced elsewhere (called in render, passed as non-event prop), skip it
    const total = totalRefs.get(handlerName) ?? 0;
    const eventCount = eventRefs.get(handlerName) ?? 0;
    // declaration (1) + event handler references (eventCount) should account for all refs
    if (total > eventCount + 1) {
      // Referenced elsewhere — not exclusively an event handler
      continue;
    }

    // Check if this is a useCallback wrapper — trace to inner callback
    const innerFn = useCallbackMap.get(handlerName);
    if (innerFn) {
      result.set(innerFn, propName);
      continue;
    }

    // Direct match — find the FunctionDependency by name
    const matchingFn = analyzed.functions.find((fn) => fn.name === handlerName);
    if (matchingFn) {
      result.set(matchingFn, propName);
    }
  }

  return result;
}

/**
 * Simple recursive AST walker.
 */
function walkNode(node: unknown, callback: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) {
      walkNode(child, callback);
    }
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

export { analyzeTaint, type TaintResult } from './taint.js';
export { analyzePurity, type PurityResult } from './purity.js';
export { classifySegment } from './boundary.js';
