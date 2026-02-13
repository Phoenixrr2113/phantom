import type { Node, CallExpression, Identifier } from 'estree';
import type { AnalyzedModule, ClassifiedSegment, FunctionDependency } from '../types.js';
import { analyzeTaint, propagateTaint, type TaintResult } from './taint.js';
import { analyzePurity } from './purity.js';
import { classifySegment } from './boundary.js';
import { EXTRACTABLE_HOOKS, CLIENT_ONLY_HOOKS } from './react-patterns.js';

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

  // Pass 2 + 3: Purity analysis + boundary detection
  const segments: ClassifiedSegment[] = [];
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const taint = taintResults.get(fn)!;
    const purity = analyzePurity(fn, taint);
    const parentHook = hookContexts.get(fn) ?? null;

    const segment = classifySegment({
      fn,
      taint,
      purity,
      parentHook,
      sourceCode,
      filePath: analyzed.path,
      index: i,
    });

    segments.push(segment);
  }

  return segments;
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

    // Check if callee is a hook identifier
    if (callee.type !== 'Identifier') return;
    const hookName = (callee as Identifier).name;
    if (!hookNames.has(hookName)) return;

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
