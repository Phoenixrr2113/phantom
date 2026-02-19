import type { Node, Identifier } from 'estree';
import type {
  AnalyzedModule,
  FunctionDependency,
  SSRClassification,
  SSRComponentResult,
  SSRModuleResult,
} from '../types.js';
import type { TaintResult } from './taint.js';
import type { ClassificationContext } from './index.js';
import { walkNode } from './index.js';
import { isBrowserGlobal, isAmbiguousGlobal } from './browser-globals.js';
import { CLIENT_ONLY_HOOKS } from './react-patterns.js';

// ── Render Path Analysis Types ────────────────────────────────────────

interface RenderPathResult {
  /** All globals referenced in the render path */
  renderGlobals: string[];
  /** Browser-only APIs found in the render path */
  browserAPIs: string[];
  /** Ambiguous (cross-env) APIs found in the render path */
  ambiguousAPIs: string[];
  /** Hooks used by this component */
  hooks: string[];
  /** Whether typeof window guards were detected */
  hasWindowGuards: boolean;
  /** Whether the component has event handlers */
  hasEventHandlers: boolean;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Classify all components in a module for SSR safety.
 *
 * Uses intermediate results from the classification pipeline to avoid
 * redundant AST walks. The classification context provides taint results,
 * hook contexts, and event handler contexts already computed.
 */
export function classifyModuleSSR(
  analyzed: AnalyzedModule,
  sourceCode: string,
  context: ClassificationContext,
): SSRModuleResult {
  // Step 1: Check for top-level browser access
  const topLevelResult = detectTopLevelBrowserAccess(analyzed);

  // Step 2: Find component functions
  const components = identifyComponents(analyzed);

  // Step 3: Detect typeof window guards across the module
  const guardedSpans = detectTypeofWindowGuards(analyzed.ast);

  // Step 4: Classify each component
  const results: SSRComponentResult[] = [];
  for (const comp of components) {
    const renderPath = analyzeRenderPath(
      comp,
      analyzed,
      context,
      guardedSpans,
      sourceCode,
    );

    const result = classifyComponent(
      comp.name,
      renderPath,
      topLevelResult.hasTopLevelBrowserAccess,
    );
    results.push(result);
  }

  return {
    components: results,
    hasTopLevelBrowserAccess: topLevelResult.hasTopLevelBrowserAccess,
    topLevelBrowserAPIs: topLevelResult.topLevelBrowserAPIs,
  };
}

// ── Component Identification ──────────────────────────────────────────

/**
 * Identify React component functions in the module.
 *
 * A function is considered a component if:
 * 1. It has a PascalCase name (starts with uppercase)
 * 2. Its body contains JSX
 * 3. It's exported (or could be — we're generous here)
 */
function identifyComponents(analyzed: AnalyzedModule): FunctionDependency[] {
  const components: FunctionDependency[] = [];
  const functionNodes = buildFunctionNodeMap(analyzed);

  for (const fn of analyzed.functions) {
    // Must have a PascalCase name
    if (fn.name === '<anonymous>' || !/^[A-Z]/.test(fn.name)) continue;

    // Must contain JSX in its body
    const node = functionNodes.get(`${fn.span.start}:${fn.span.end}`);
    if (!node || !containsJSX(node)) continue;

    components.push(fn);
  }

  return components;
}

// ── Render Path Analysis ──────────────────────────────────────────────

/**
 * Analyze the "render path" of a component — the code that runs during
 * renderToString() on the server.
 *
 * The render path EXCLUDES:
 * - useEffect/useLayoutEffect callback bodies (never run during SSR)
 * - Event handler functions (never run during SSR)
 * - Code inside `typeof window !== 'undefined'` guards
 *
 * The render path INCLUDES:
 * - Top-level component body statements
 * - useMemo/useCallback callback bodies (these DO run during SSR)
 * - Conditional logic affecting JSX
 */
function analyzeRenderPath(
  component: FunctionDependency,
  analyzed: AnalyzedModule,
  context: ClassificationContext,
  guardedSpans: Set<string>,
  _sourceCode: string,
): RenderPathResult {
  const { taintResults, hookContexts, eventHandlerContexts } = context;

  const renderGlobals: string[] = [];
  const browserAPIs: string[] = [];
  const ambiguousAPIs: string[] = [];
  const hooks: string[] = [];
  let hasWindowGuards = false;
  let hasEventHandlers = false;

  // Collect hooks used by this component by checking child functions
  for (const fn of analyzed.functions) {
    // Only consider functions nested inside this component
    if (fn.span.start < component.span.start || fn.span.end > component.span.end) {
      continue;
    }

    const hookName = hookContexts.get(fn);
    if (hookName && !hooks.includes(hookName)) {
      hooks.push(hookName);
    }

    if (eventHandlerContexts.has(fn)) {
      hasEventHandlers = true;
    }
  }

  // Also detect hooks from direct calls in the component body (useState, useRef, etc.)
  const componentNode = findFunctionNode(analyzed.ast, component.span);
  if (componentNode) {
    collectDirectHookCalls(componentNode, hooks);
  }

  // Now analyze globals in the render path.
  //
  // IMPORTANT: We do NOT use component.globals as a starting point because
  // eslint-scope's "through" references include globals from ALL nested scopes
  // (useEffect callbacks, event handlers, etc.). Instead, we build the render
  // path globals bottom-up: only include globals from nested functions that
  // ARE in the render path.

  // Step A: Identify which nested functions are excluded from the render path
  const excludedSpans = new Set<string>();

  for (const fn of analyzed.functions) {
    if (fn === component) continue;
    if (fn.span.start < component.span.start || fn.span.end > component.span.end) {
      continue;
    }

    const hookName = hookContexts.get(fn);
    if (hookName && CLIENT_ONLY_HOOKS.has(hookName)) {
      excludedSpans.add(`${fn.span.start}:${fn.span.end}`);
      continue;
    }

    if (eventHandlerContexts.has(fn)) {
      excludedSpans.add(`${fn.span.start}:${fn.span.end}`);
      continue;
    }

    const spanKey = `${fn.span.start}:${fn.span.end}`;
    if (guardedSpans.has(spanKey)) {
      hasWindowGuards = true;
      excludedSpans.add(spanKey);
      continue;
    }
  }

  // Step B: Collect render path globals — only from non-excluded functions
  const renderPathGlobals = new Set<string>();

  for (const fn of analyzed.functions) {
    if (fn.span.start < component.span.start || fn.span.end > component.span.end) {
      continue;
    }

    const spanKey = `${fn.span.start}:${fn.span.end}`;

    // Skip excluded functions
    if (fn !== component && excludedSpans.has(spanKey)) continue;

    // Skip functions nested inside an excluded function
    if (fn !== component && isInsideExcludedSpan(fn.span.start, fn.span.end, excludedSpans)) continue;

    // For the component itself, we can't use its globals directly because
    // they include through-references from nested scopes. Instead, only
    // include the component's globals if they DON'T come from excluded children.
    if (fn === component) {
      // The component's "own" globals (not from nested functions) are those
      // that appear in its globals list but aren't exclusively from excluded children.
      // We compute this by: component.globals MINUS globals that ONLY appear in excluded children.
      const excludedOnlyGlobals = collectGlobalsOnlyInExcluded(component, analyzed.functions, excludedSpans);
      for (const g of component.globals) {
        if (!excludedOnlyGlobals.has(g)) {
          renderPathGlobals.add(g);
        }
      }
    } else {
      for (const g of fn.globals) {
        renderPathGlobals.add(g);
      }
    }
  }

  // Step C: Remove guarded globals and typeof-checked globals
  if (componentNode && guardedSpans.size > 0) {
    const guardedGlobals = collectGuardedGlobals(componentNode, guardedSpans);
    if (guardedGlobals.size > 0) {
      hasWindowGuards = true;
      for (const g of guardedGlobals) {
        renderPathGlobals.delete(g);
      }
    }
  }

  // Step C2: Handle `typeof window` — the `window` in `typeof window !== 'undefined'`
  // is safe (typeof never throws) and should not count as browser API usage.
  // If `window` is only referenced via typeof checks and inside guards, remove it.
  if (componentNode && renderPathGlobals.has('window')) {
    const allWindowUsages = countGlobalUsages(componentNode, 'window');
    const typeofWindowUsages = countTypeofUsages(componentNode, 'window');
    if (allWindowUsages > 0 && allWindowUsages === typeofWindowUsages) {
      // All window references are typeof checks — safe to remove
      renderPathGlobals.delete('window');
      hasWindowGuards = true;
    }
  }

  // Step D: Classify the render path globals
  for (const g of renderPathGlobals) {
    renderGlobals.push(g);
    if (isBrowserGlobal(g)) {
      browserAPIs.push(g);
    } else if (isAmbiguousGlobal(g)) {
      ambiguousAPIs.push(g);
    }
  }

  return {
    renderGlobals,
    browserAPIs,
    ambiguousAPIs,
    hooks,
    hasWindowGuards,
    hasEventHandlers,
  };
}

// ── typeof window Guard Detection ─────────────────────────────────────

/**
 * Detect `typeof window` guard patterns in the AST.
 *
 * Supported patterns:
 * - `if (typeof window !== 'undefined') { ... }`
 * - `if (typeof window === 'undefined') { ... } else { ... }`
 * - `typeof window !== 'undefined' && expr` (short-circuit)
 * - `const isClient = typeof window !== 'undefined'`
 *
 * Returns a Set of span keys ("start:end") for AST nodes that are
 * inside a browser-only guard (the consequent of the check).
 */
function detectTypeofWindowGuards(ast: Node): Set<string> {
  const guardedSpans = new Set<string>();

  walkNode(ast, (node) => {
    // Pattern 1: if (typeof window !== 'undefined') { ... }
    if (node.type === 'IfStatement') {
      const ifNode = node as Node & {
        test: Node;
        consequent: Node;
        alternate: Node | null;
      };

      if (isTypeofWindowCheck(ifNode.test, '!==')) {
        // The consequent is browser-only code
        addSpansFromNode(ifNode.consequent, guardedSpans);
      } else if (isTypeofWindowCheck(ifNode.test, '===')) {
        // Inverted: typeof window === 'undefined' → else branch is browser code
        if (ifNode.alternate) {
          addSpansFromNode(ifNode.alternate, guardedSpans);
        }
      }
    }

    // Pattern 2: typeof window !== 'undefined' && expr (short-circuit)
    if (node.type === 'LogicalExpression') {
      const logical = node as Node & {
        operator: string;
        left: Node;
        right: Node;
      };
      if (logical.operator === '&&' && isTypeofWindowCheck(logical.left, '!==')) {
        addSpansFromNode(logical.right, guardedSpans);
      }
    }
  });

  return guardedSpans;
}

/**
 * Check if a node is a `typeof window !== 'undefined'` or `typeof window === 'undefined'` test.
 */
function isTypeofWindowCheck(node: Node, operator: '!==' | '==='): boolean {
  if (node.type !== 'BinaryExpression') return false;

  const binary = node as Node & {
    operator: string;
    left: Node;
    right: Node;
  };

  if (binary.operator !== operator && binary.operator !== operator.slice(0, 2)) {
    return false;
  }

  // Check for typeof window on left
  const left = binary.left;
  const right = binary.right;

  return (
    (isTypeofWindow(left) && isUndefinedLiteral(right)) ||
    (isUndefinedLiteral(left) && isTypeofWindow(right))
  );
}

function isTypeofWindow(node: Node): boolean {
  if (node.type !== 'UnaryExpression') return false;
  const unary = node as Node & { operator: string; argument: Node };
  if (unary.operator !== 'typeof') return false;
  return unary.argument.type === 'Identifier' && (unary.argument as Identifier).name === 'window';
}

function isUndefinedLiteral(node: Node): boolean {
  if (node.type === 'Literal') {
    return (node as Node & { value: unknown }).value === 'undefined';
  }
  return false;
}

/**
 * Add all function-level spans within a node to the guarded set.
 */
function addSpansFromNode(node: Node, spans: Set<string>): void {
  const start = (node as Node & { start?: number }).start;
  const end = (node as Node & { end?: number }).end;
  if (start != null && end != null) {
    spans.add(`${start}:${end}`);
  }

  // Also add spans for any nested functions
  walkNode(node, (child) => {
    if (
      child.type === 'FunctionDeclaration' ||
      child.type === 'FunctionExpression' ||
      child.type === 'ArrowFunctionExpression'
    ) {
      const cStart = (child as Node & { start?: number }).start;
      const cEnd = (child as Node & { end?: number }).end;
      if (cStart != null && cEnd != null) {
        spans.add(`${cStart}:${cEnd}`);
      }
    }
  });
}

// ── Top-Level Browser Access Detection ────────────────────────────────

/**
 * Detect browser API references at module scope (outside any function).
 *
 * If found, the entire module is ClientOnly regardless of component analysis.
 * Example: `const width = window.innerWidth;` at top level.
 */
function detectTopLevelBrowserAccess(analyzed: AnalyzedModule): {
  hasTopLevelBrowserAccess: boolean;
  topLevelBrowserAPIs: string[];
} {
  const topLevelBrowserAPIs: string[] = [];

  // Module-level globals are variables referenced outside any function scope.
  // We check for globals that aren't captured by any function — they're at module scope.
  // The AST body statements outside function declarations are module-scope.

  // Walk top-level statements of the module
  const body = analyzed.ast.body;
  const functionSpans = new Set<string>();
  for (const fn of analyzed.functions) {
    functionSpans.add(`${fn.span.start}:${fn.span.end}`);
  }

  // Collect identifiers at module scope (not inside any function)
  walkNode(body, (node) => {
    if (node.type === 'Identifier') {
      const name = (node as Identifier).name;
      if (isBrowserGlobal(name)) {
        // Check this identifier is not inside a function body
        // We approximate: if the identifier is at module scope
        // (its position isn't within any function span)
        const pos = (node as Node & { start?: number }).start;
        if (pos != null && !isInsideAnyFunction(pos, analyzed.functions)) {
          if (!topLevelBrowserAPIs.includes(name)) {
            topLevelBrowserAPIs.push(name);
          }
        }
      }
    }
  });

  return {
    hasTopLevelBrowserAccess: topLevelBrowserAPIs.length > 0,
    topLevelBrowserAPIs,
  };
}

function isInsideAnyFunction(pos: number, functions: FunctionDependency[]): boolean {
  return functions.some(fn => pos >= fn.span.start && pos <= fn.span.end);
}

// ── Component Classification ──────────────────────────────────────────

/**
 * Classify a single component based on its render path analysis.
 */
function classifyComponent(
  name: string,
  renderPath: RenderPathResult,
  hasTopLevelBrowserAccess: boolean,
): SSRComponentResult {
  let classification: SSRClassification;
  let confidence: number;
  const reasons: string[] = [];

  // Rule 1: Module has top-level browser access → entire module is ClientOnly
  if (hasTopLevelBrowserAccess) {
    classification = 'ClientOnly';
    confidence = 1.0;
    reasons.push('Module has top-level browser API access');
  }
  // Rule 2: Render path references browser-only APIs → ClientOnly
  else if (renderPath.browserAPIs.length > 0) {
    classification = 'ClientOnly';
    confidence = 0.95;
    reasons.push(`Render path references browser APIs: ${renderPath.browserAPIs.join(', ')}`);
  }
  // Rule 3: No hooks, no handlers, no guards, pure props→JSX → FullyStatic
  else if (
    renderPath.hooks.length === 0 &&
    !renderPath.hasEventHandlers &&
    !renderPath.hasWindowGuards &&
    renderPath.ambiguousAPIs.length === 0
  ) {
    classification = 'FullyStatic';
    confidence = 0.9;
    reasons.push('Pure props-to-JSX component with no hooks or handlers');
  }
  // Rule 4: Has hooks/state but render path is clean → SSRSafe
  else if (renderPath.browserAPIs.length === 0) {
    classification = 'SSRSafe';
    confidence = renderPath.ambiguousAPIs.length > 0 ? 0.7 : 0.85;
    reasons.push('Render path is free of browser APIs');
    if (renderPath.hooks.length > 0) {
      reasons.push(`Uses hooks: ${renderPath.hooks.join(', ')}`);
    }
    if (renderPath.hasEventHandlers) {
      reasons.push('Has event handlers (excluded from render path)');
    }
    if (renderPath.hasWindowGuards) {
      reasons.push('Browser access is guarded by typeof window checks');
    }
    if (renderPath.ambiguousAPIs.length > 0) {
      reasons.push(`Cross-environment APIs in render: ${renderPath.ambiguousAPIs.join(', ')}`);
    }
  }
  // Fallback (shouldn't reach here given the rules above)
  else {
    classification = 'ClientOnly';
    confidence = 0.5;
    reasons.push('Could not determine SSR safety');
  }

  return {
    name,
    classification,
    confidence,
    reasons,
    renderPathBrowserAPIs: renderPath.browserAPIs,
    hooks: renderPath.hooks,
    hasWindowGuards: renderPath.hasWindowGuards,
  };
}

// ── Render Path Helpers ───────────────────────────────────────────────

/**
 * Check if a span is nested inside any excluded span.
 */
function isInsideExcludedSpan(
  start: number,
  end: number,
  excludedSpans: Set<string>,
): boolean {
  for (const spanKey of excludedSpans) {
    const [exStartStr, exEndStr] = spanKey.split(':');
    const exStart = parseInt(exStartStr, 10);
    const exEnd = parseInt(exEndStr, 10);
    if (start >= exStart && end <= exEnd) {
      return true;
    }
  }
  return false;
}

/**
 * Collect globals that ONLY appear in excluded child functions.
 *
 * A global is "excluded-only" if:
 * - It appears in at least one excluded child function's globals
 * - It does NOT appear in any non-excluded child function's globals
 *
 * These globals come from nested scopes (useEffect, event handlers) and
 * should not count as render-path globals even though eslint-scope's
 * through-references include them in the parent component's globals.
 */
function collectGlobalsOnlyInExcluded(
  component: FunctionDependency,
  functions: FunctionDependency[],
  excludedSpans: Set<string>,
): Set<string> {
  const globalsInExcluded = new Set<string>();
  const globalsInRenderPath = new Set<string>();

  for (const fn of functions) {
    if (fn === component) continue;
    if (fn.span.start < component.span.start || fn.span.end > component.span.end) {
      continue;
    }

    const spanKey = `${fn.span.start}:${fn.span.end}`;
    const isExcluded = excludedSpans.has(spanKey) ||
      isInsideExcludedSpan(fn.span.start, fn.span.end, excludedSpans);

    for (const g of fn.globals) {
      if (isExcluded) {
        globalsInExcluded.add(g);
      } else {
        globalsInRenderPath.add(g);
      }
    }
  }

  // Return globals that are in excluded but NOT in render path
  const excludedOnly = new Set<string>();
  for (const g of globalsInExcluded) {
    if (!globalsInRenderPath.has(g)) {
      excludedOnly.add(g);
    }
  }
  return excludedOnly;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Build a map from span key to AST node for function nodes.
 */
function buildFunctionNodeMap(analyzed: AnalyzedModule): Map<string, Node> {
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
 * Check if an AST node contains any JSX elements or fragments.
 */
function containsJSX(node: Node): boolean {
  let found = false;
  walkNode(node, (n) => {
    if (found) return;
    if ((n.type as string).startsWith('JSX')) found = true;
  });
  return found;
}

/**
 * Find the AST node for a function by its span.
 */
function findFunctionNode(ast: Node, span: { start: number; end: number }): Node | null {
  let result: Node | null = null;
  walkNode(ast, (node) => {
    if (result) return;
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const start = (node as Node & { start?: number }).start;
      const end = (node as Node & { end?: number }).end;
      if (start === span.start && end === span.end) {
        result = node;
      }
    }
  });
  return result;
}

/**
 * Collect hook calls made directly in a component body (not inside nested functions).
 * Detects patterns like: useState(), useRef(), useContext(), etc.
 */
function collectDirectHookCalls(componentNode: Node, hooks: string[]): void {
  walkNode(componentNode, (node) => {
    if (node.type !== 'CallExpression') return;

    const call = node as Node & { callee: Node };
    let hookName: string | null = null;

    if (call.callee.type === 'Identifier') {
      const name = (call.callee as Identifier).name;
      if (name.startsWith('use')) hookName = name;
    } else if (call.callee.type === 'MemberExpression') {
      const prop = (call.callee as Node & { property: Node }).property;
      if (prop.type === 'Identifier') {
        const name = (prop as Identifier).name;
        if (name.startsWith('use')) hookName = name;
      }
    }

    if (hookName && !hooks.includes(hookName)) {
      hooks.push(hookName);
    }
  });
}

/**
 * Count total references to a specific identifier in a node.
 */
function countGlobalUsages(node: Node, name: string): number {
  let count = 0;
  walkNode(node, (n) => {
    if (n.type === 'Identifier' && (n as Identifier).name === name) {
      count++;
    }
  });
  return count;
}

/**
 * Count how many times an identifier appears inside a `typeof` expression.
 * `typeof window` is safe (never throws) and shouldn't count as API access.
 */
function countTypeofUsages(node: Node, name: string): number {
  let count = 0;
  walkNode(node, (n) => {
    if (n.type === 'UnaryExpression') {
      const unary = n as Node & { operator: string; argument: Node };
      if (
        unary.operator === 'typeof' &&
        unary.argument.type === 'Identifier' &&
        (unary.argument as Identifier).name === name
      ) {
        count++;
      }
    }
  });
  return count;
}

/**
 * Collect global identifiers that are inside guarded blocks.
 * Used to filter out browser APIs that are safely guarded by typeof window checks.
 */
function collectGuardedGlobals(componentNode: Node, guardedSpans: Set<string>): Set<string> {
  const guardedGlobals = new Set<string>();

  walkNode(componentNode, (node) => {
    if (node.type !== 'Identifier') return;
    const name = (node as Identifier).name;
    if (!isBrowserGlobal(name) && !isAmbiguousGlobal(name)) return;

    const pos = (node as Node & { start?: number }).start;
    if (pos == null) return;

    // Check if this identifier is inside any guarded span
    for (const spanKey of guardedSpans) {
      const [startStr, endStr] = spanKey.split(':');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (pos >= start && pos <= end) {
        guardedGlobals.add(name);
        break;
      }
    }
  });

  return guardedGlobals;
}
