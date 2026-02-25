import type {
  Node,
  Program,
  Identifier,
  ImportDeclaration,
  VariableDeclaration,
  VariableDeclarator,
  CallExpression,
  ArrowFunctionExpression,
  Literal,
  MemberExpression,
  ObjectExpression,
  Property,
  SpreadElement,
} from 'estree';
import type { LazyCandidate } from '../types.js';

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Apply React.lazy + Suspense transforms to a cloned AST.
 *
 * Mutates the AST in place:
 * 1. Rewrites component imports → React.lazy(() => import(...))
 * 2. Wraps JSX usages in <Suspense fallback={null}>
 * 3. Ensures `lazy` and `Suspense` are imported from 'react'
 *
 * Should be called on a structuredClone of the original AST.
 */
export function applyLazyTransforms(
  ast: Program,
  candidates: LazyCandidate[],
): void {
  if (candidates.length === 0) return;

  // Step 1: Rewrite imports → lazy declarations
  for (const candidate of candidates) {
    rewriteImportToLazy(ast, candidate);
  }

  // Step 2: Wrap JSX usages in Suspense boundaries
  // Group candidates by suspenseGroup for batch wrapping
  const grouped = groupBySuspense(candidates);
  for (const group of grouped) {
    wrapInSuspense(ast, group);
  }

  // Step 3: Ensure React imports include lazy and Suspense
  ensureReactImports(ast);
}

// ── Import rewriting ────────────────────────────────────────────────────

/**
 * Rewrite a static component import to a React.lazy declaration.
 *
 * Handles three cases:
 *
 *   Default import:
 *     import Foo from './Foo'
 *     → const Foo = lazy(() => import('./Foo'))
 *
 *   Named import:
 *     import { Foo } from './Foo'
 *     → const Foo = lazy(() => import('./Foo').then(m => ({ default: m.Foo })))
 *
 *   Named import (only specifier):
 *     Removes the entire import declaration.
 *
 *   Named import (one of several):
 *     Removes only the component specifier, keeps the rest.
 */
function rewriteImportToLazy(ast: Program, candidate: LazyCandidate): void {
  // Find the import declaration that contains this specifier.
  // Match on the original `source` (as written in the module), not `resolvedSource`.
  const importIndex = ast.body.findIndex((node) => {
    if (node.type !== 'ImportDeclaration') return false;
    const decl = node as ImportDeclaration;
    return decl.source.value === candidate.source &&
      decl.specifiers.some((s) => {
        if (s.type === 'ImportDefaultSpecifier') return s.local.name === candidate.localName;
        if (s.type === 'ImportSpecifier') return s.local.name === candidate.localName;
        return false;
      });
  });

  if (importIndex === -1) return;

  const importDecl = ast.body[importIndex] as ImportDeclaration;

  // Build the lazy() call
  const lazyDecl = buildLazyDeclaration(candidate);

  if (importDecl.specifiers.length === 1) {
    // Only specifier — replace entire import with lazy declaration
    ast.body[importIndex] = lazyDecl;
  } else {
    // Multiple specifiers — remove just this one, add lazy declaration after
    importDecl.specifiers = importDecl.specifiers.filter((s) => {
      if (s.type === 'ImportDefaultSpecifier') return s.local.name !== candidate.localName;
      if (s.type === 'ImportSpecifier') return s.local.name !== candidate.localName;
      return true;
    });
    // Insert lazy declaration right after the import
    ast.body.splice(importIndex + 1, 0, lazyDecl);
  }
}

/**
 * Build: const Foo = lazy(() => import('./Foo'))
 * Or for named exports: const Foo = lazy(() => import('./Foo').then(m => ({ default: m.Foo })))
 */
function buildLazyDeclaration(candidate: LazyCandidate): VariableDeclaration {
  let importExpr: CallExpression | ArrowFunctionExpression;

  // Use resolvedSource (barrel-resolved) for the dynamic import target,
  // falling back to the original source if no resolution was needed.
  const importTarget = candidate.resolvedSource ?? candidate.source;

  // The dynamic import expression
  const dynamicImport: CallExpression = {
    type: 'CallExpression',
    callee: {
      type: 'Import',
    } as unknown as Identifier, // ImportExpression represented as CallExpression for compat
    arguments: [
      { type: 'Literal', value: importTarget } as Literal,
    ],
    optional: false,
  };

  // For ESTree, dynamic import is actually ImportExpression, but we model it
  // in a way esrap can handle
  const importExpression = {
    type: 'ImportExpression',
    source: { type: 'Literal', value: importTarget } as Literal,
  };

  let factoryBody: Node;

  if (candidate.importKind === 'default') {
    // Default import: lazy(() => import('./Foo'))
    // The module already has a default export, React.lazy handles it
    factoryBody = importExpression as unknown as Node;
  } else {
    // Named import: lazy(() => import('./Foo').then(m => ({ default: m.Foo })))
    // React.lazy requires the promise to resolve with { default: Component }
    const exportedName = candidate.importedName ?? candidate.localName;

    factoryBody = {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: importExpression as unknown as Node,
        property: { type: 'Identifier', name: 'then' } as Identifier,
        computed: false,
        optional: false,
      } as MemberExpression,
      arguments: [
        {
          type: 'ArrowFunctionExpression',
          params: [{ type: 'Identifier', name: 'm' } as Identifier],
          body: {
            type: 'ObjectExpression',
            properties: [
              {
                type: 'Property',
                key: { type: 'Identifier', name: 'default' } as Identifier,
                value: {
                  type: 'MemberExpression',
                  object: { type: 'Identifier', name: 'm' } as Identifier,
                  property: { type: 'Identifier', name: exportedName } as Identifier,
                  computed: false,
                  optional: false,
                } as MemberExpression,
                kind: 'init',
                method: false,
                shorthand: false,
                computed: false,
              } as Property,
            ],
          } as ObjectExpression,
          expression: true,
          async: false,
          generator: false,
        } as ArrowFunctionExpression,
      ],
      optional: false,
    } as CallExpression;
  }

  // The factory arrow: () => import(...)  or  () => import(...).then(...)
  const factory: ArrowFunctionExpression = {
    type: 'ArrowFunctionExpression',
    params: [],
    body: factoryBody as ArrowFunctionExpression['body'],
    expression: true,
    async: false,
    generator: false,
  };

  // lazy(factory)
  const lazyCall: CallExpression = {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: 'lazy' } as Identifier,
    arguments: [factory],
    optional: false,
  };

  // const Foo = lazy(...)
  return {
    type: 'VariableDeclaration',
    declarations: [
      {
        type: 'VariableDeclarator',
        id: { type: 'Identifier', name: candidate.localName } as Identifier,
        init: lazyCall,
      } as VariableDeclarator,
    ],
    kind: 'const',
  };
}

// ── Suspense wrapping ───────────────────────────────────────────────────

interface SuspenseGroup {
  candidates: LazyCandidate[];
  groupId: string | null;
}

function groupBySuspense(candidates: LazyCandidate[]): SuspenseGroup[] {
  const grouped = new Map<string, LazyCandidate[]>();
  const ungrouped: LazyCandidate[] = [];

  for (const c of candidates) {
    if (c.suspenseGroup) {
      let group = grouped.get(c.suspenseGroup);
      if (!group) {
        group = [];
        grouped.set(c.suspenseGroup, group);
      }
      group.push(c);
    } else {
      ungrouped.push(c);
    }
  }

  const result: SuspenseGroup[] = [];

  // Grouped candidates share a Suspense boundary
  for (const [groupId, cands] of grouped) {
    result.push({ candidates: cands, groupId });
  }

  // Ungrouped candidates each get their own boundary
  for (const c of ungrouped) {
    result.push({ candidates: [c], groupId: null });
  }

  return result;
}

/**
 * Wrap JSX usages of lazy components in <Suspense fallback={null}>.
 *
 * For grouped candidates (adjacent siblings), wraps them all in a
 * single Suspense boundary. For individual candidates, wraps each
 * JSX element independently.
 *
 * Walks the AST looking for parent elements whose children include
 * the target JSX elements, then splices in the Suspense wrapper.
 */
function wrapInSuspense(ast: Program, group: SuspenseGroup): void {
  const targetNames = new Set(group.candidates.map((c) => c.localName));

  // Collect mutations first, apply after walk to avoid infinite recursion
  // (walkAndMutate would recurse into newly created Suspense nodes)
  interface Mutation {
    children: unknown[];
    matches: Array<{ index: number; kind: 'direct' | 'conditional' }>;
  }
  const mutations: Mutation[] = [];

  walkAndMutate(ast, (node) => {
    const children = getJSXChildren(node);
    if (!children) return;

    const matches: Array<{ index: number; kind: 'direct' | 'conditional' }> = [];

    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Record<string, unknown>;

      // Case 1: Direct JSXElement child — <PaymentForm />
      if (child.type === 'JSXElement') {
        if (isTargetJSXElement(child, targetNames)) {
          matches.push({ index: i, kind: 'direct' });
        }
        continue;
      }

      // Case 2: JSXExpressionContainer — {cond && <PromoCode />} or {cond ? <A/> : <B/>}
      if (child.type === 'JSXExpressionContainer') {
        const expr = child.expression as Record<string, unknown> | undefined;
        if (expr && containsTargetJSXElement(expr, targetNames)) {
          matches.push({ index: i, kind: 'conditional' });
        }
      }
    }

    if (matches.length > 0) {
      mutations.push({ children, matches });
    }
  });

  // Apply mutations after the walk is complete
  for (const { children, matches } of mutations) {
    const directMatches = matches.filter((m) => m.kind === 'direct');
    const conditionalMatches = matches.filter((m) => m.kind === 'conditional');

    // Handle grouped direct children (adjacent siblings share one Suspense)
    if (group.candidates.length > 1 && directMatches.length > 1) {
      const first = Math.min(...directMatches.map((m) => m.index));
      const last = Math.max(...directMatches.map((m) => m.index));
      const wrapped = children.splice(first, last - first + 1);
      const suspenseElement = buildSuspenseJSX(wrapped);
      children.splice(first, 0, suspenseElement);
      // Adjust conditional indices after splice
      const offset = (last - first + 1) - 1;
      for (const cm of conditionalMatches) {
        if (cm.index > last) cm.index -= offset;
      }
    } else {
      // Individual direct children (process in reverse to preserve indices)
      for (let i = directMatches.length - 1; i >= 0; i--) {
        const idx = directMatches[i].index;
        const child = children[idx];
        children[idx] = buildSuspenseJSX([child]);
      }
    }

    // Handle conditional children — wrap the JSXElement inside the conditional expression
    for (let i = conditionalMatches.length - 1; i >= 0; i--) {
      const idx = conditionalMatches[i].index;
      const child = children[idx] as Record<string, unknown>;
      if (child.type === 'JSXExpressionContainer') {
        const expr = child.expression as Record<string, unknown>;
        wrapTargetInConditionalExpr(expr, targetNames);
      }
    }
  }
}

/** Check if a JSXElement node has a tag name in the target set */
function isTargetJSXElement(node: Record<string, unknown>, targets: Set<string>): boolean {
  if (node.type !== 'JSXElement') return false;
  const opening = node.openingElement as Record<string, unknown> | undefined;
  const name = opening?.name as Record<string, unknown> | undefined;
  return name?.type === 'JSXIdentifier' && targets.has(name.name as string);
}

/** Check if an expression contains a target JSXElement (e.g., in && or ternary) */
function containsTargetJSXElement(expr: Record<string, unknown>, targets: Set<string>): boolean {
  if (isTargetJSXElement(expr, targets)) return true;

  // cond && <Target />
  if (expr.type === 'LogicalExpression') {
    const right = expr.right as Record<string, unknown> | undefined;
    if (right && isTargetJSXElement(right, targets)) return true;
    const left = expr.left as Record<string, unknown> | undefined;
    if (left && isTargetJSXElement(left, targets)) return true;
  }

  // cond ? <Target /> : fallback
  if (expr.type === 'ConditionalExpression') {
    const consequent = expr.consequent as Record<string, unknown> | undefined;
    const alternate = expr.alternate as Record<string, unknown> | undefined;
    if (consequent && isTargetJSXElement(consequent, targets)) return true;
    if (alternate && isTargetJSXElement(alternate, targets)) return true;
  }

  return false;
}

/**
 * Wrap the target JSXElement inside a conditional expression with Suspense.
 * {cond && <Target />} → {cond && <Suspense fallback={null}><Target /></Suspense>}
 */
function wrapTargetInConditionalExpr(expr: Record<string, unknown>, targets: Set<string>): void {
  // cond && <Target />
  if (expr.type === 'LogicalExpression') {
    const right = expr.right as Record<string, unknown> | undefined;
    if (right && isTargetJSXElement(right, targets)) {
      expr.right = buildSuspenseJSX([right]);
      return;
    }
    const left = expr.left as Record<string, unknown> | undefined;
    if (left && isTargetJSXElement(left, targets)) {
      expr.left = buildSuspenseJSX([left]);
      return;
    }
  }

  // cond ? <Target /> : fallback
  if (expr.type === 'ConditionalExpression') {
    const consequent = expr.consequent as Record<string, unknown> | undefined;
    if (consequent && isTargetJSXElement(consequent, targets)) {
      expr.consequent = buildSuspenseJSX([consequent]);
    }
    const alternate = expr.alternate as Record<string, unknown> | undefined;
    if (alternate && isTargetJSXElement(alternate, targets)) {
      expr.alternate = buildSuspenseJSX([alternate]);
    }
  }
}

/**
 * Build a <Suspense fallback={null}>...children...</Suspense> JSX element.
 */
function buildSuspenseJSX(children: unknown[]): Record<string, unknown> {
  return {
    type: 'JSXElement',
    openingElement: {
      type: 'JSXOpeningElement',
      name: { type: 'JSXIdentifier', name: 'Suspense' },
      attributes: [
        {
          type: 'JSXAttribute',
          name: { type: 'JSXIdentifier', name: 'fallback' },
          value: {
            type: 'JSXExpressionContainer',
            expression: { type: 'Literal', value: null, raw: 'null' },
          },
        },
      ],
      selfClosing: false,
    },
    closingElement: {
      type: 'JSXClosingElement',
      name: { type: 'JSXIdentifier', name: 'Suspense' },
    },
    children,
  };
}

// ── React import management ─────────────────────────────────────────────

/**
 * Ensure the module imports `lazy` and `Suspense` from 'react'.
 *
 * If an existing `import { ... } from 'react'` exists, adds the missing
 * specifiers. Otherwise, prepends a new import declaration.
 */
function ensureReactImports(ast: Program): void {
  const needed = new Set(['lazy', 'Suspense']);

  // Find existing react import
  const reactImport = ast.body.find(
    (node) =>
      node.type === 'ImportDeclaration' &&
      (node as ImportDeclaration).source.value === 'react',
  ) as ImportDeclaration | undefined;

  if (reactImport) {
    // Check if this is a namespace import (import * as React from 'react')
    // — cannot mix namespace with named specifiers in the same declaration
    const isNamespaceImport = reactImport.specifiers.some(
      (s) => s.type === 'ImportNamespaceSpecifier',
    );

    if (isNamespaceImport) {
      // Add a separate named import declaration for lazy/Suspense
      const specifiers = [...needed].map((name) => ({
        type: 'ImportSpecifier' as const,
        imported: { type: 'Identifier' as const, name } as Identifier,
        local: { type: 'Identifier' as const, name } as Identifier,
      }));

      const newImport: ImportDeclaration = {
        type: 'ImportDeclaration',
        specifiers,
        source: { type: 'Literal', value: 'react' } as Literal,
        attributes: [],
      };

      // Insert right after the existing react import
      const idx = ast.body.indexOf(reactImport);
      ast.body.splice(idx + 1, 0, newImport);
    } else {
      // Check which specifiers already exist
      for (const spec of reactImport.specifiers) {
        if (spec.type === 'ImportSpecifier') {
          needed.delete((spec.imported as Identifier).name);
        }
      }

      // Add missing specifiers
      for (const name of needed) {
        reactImport.specifiers.push({
          type: 'ImportSpecifier',
          imported: { type: 'Identifier', name } as Identifier,
          local: { type: 'Identifier', name } as Identifier,
        });
      }
    }
  } else {
    // No react import exists — add one
    const specifiers = [...needed].map((name) => ({
      type: 'ImportSpecifier' as const,
      imported: { type: 'Identifier' as const, name } as Identifier,
      local: { type: 'Identifier' as const, name } as Identifier,
    }));

    const newImport: ImportDeclaration = {
      type: 'ImportDeclaration',
      specifiers,
      source: { type: 'Literal', value: 'react' } as Literal,
      attributes: [],
    };

    ast.body.unshift(newImport);
  }
}

// ── AST helpers ─────────────────────────────────────────────────────────

/**
 * Get JSX children array from a node, if it has one.
 * Returns the actual array reference (for mutation).
 */
function getJSXChildren(node: Record<string, unknown>): unknown[] | null {
  if (node.type !== 'JSXElement' && node.type !== 'JSXFragment') return null;
  const children = node.children;
  if (!Array.isArray(children)) return null;
  return children;
}

/**
 * Keys that are not AST children — skip to avoid traversing metadata
 * objects or potential circular references from scope analysis.
 */
const SKIP_KEYS = new Set([
  'type', 'range', 'loc', 'start', 'end',
  'parent', 'scope', 'raw',
  'trailingComments', 'leadingComments', 'innerComments',
]);

/**
 * Walk AST nodes, allowing mutation at each level.
 * The callback receives the raw object for direct property access.
 */
function walkAndMutate(
  node: unknown,
  callback: (node: Record<string, unknown>) => void,
): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) walkAndMutate(child, callback);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (typeof obj.type !== 'string') return;

  callback(obj);

  for (const key of Object.keys(obj)) {
    if (SKIP_KEYS.has(key)) continue;
    walkAndMutate(obj[key], callback);
  }
}
