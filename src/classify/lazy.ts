import { dirname, relative, resolve } from 'node:path';
import type { Node, Identifier } from 'estree';
import type {
  AnalyzedModule,
  ClassifiedSegment,
  LazyCandidate,
  LazyCandidateResult,
  ComponentProfile,
  PrefetchStrategy,
} from '../types.js';

/** Re-export map type: barrel file path → (exportedName → { source, importedName }) */
type ReExportMap = Map<string, Map<string, { source: string; importedName: string }>>;

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Minimum estimated source size (bytes) for a component to be worth lazifying.
 * Below this threshold, the Suspense boundary overhead (~200 bytes of wrapper
 * code plus a loading waterfall step) exceeds the savings from code-splitting.
 * Source files under 512 bytes are typically tiny leaf components, icons, or
 * re-export wrappers where lazy loading would be counter-productive.
 */
const MIN_JS_COST_BYTES = 512;

/**
 * JSX position threshold: children at or above this index in a route-level
 * component's render tree are assumed to be below the initial viewport.
 * This is a conservative heuristic — positions 0 and 1 are kept static.
 */
const BELOW_FOLD_POSITION = 2;

/**
 * Component names that are almost certainly context providers.
 * Matched as suffixes (e.g., "ThemeProvider", "AuthProvider").
 */
const PROVIDER_SUFFIXES = ['Provider', 'Context'];

/**
 * Known route-level wrapper component names.
 * These are the parent components where we count child JSX positions.
 */
const ROUTE_COMPONENT_PATTERNS = /^(Page|Layout|Route|Screen|View|Template)$|Page$|Layout$|Screen$|View$/;

// ── Main entry ──────────────────────────────────────────────────────────

/**
 * Detect which imported child components are candidates for React.lazy wrapping.
 *
 * Runs after segment classification so it can use handler/effect counts
 * from sibling modules (via componentProfiles). Works standalone with
 * heuristics when profiles aren't available.
 *
 * @param analyzed    - The parsed + scope-analyzed module
 * @param sourceCode  - Raw source text
 * @param segments    - Already-classified segments for THIS module
 * @param componentProfiles - Optional: analysis results from imported modules
 *                            (keyed by resolved file path or import source)
 * @param reExportMap - Optional: barrel file re-export mappings accumulated during build
 */
export function detectLazyCandidates(
  analyzed: AnalyzedModule,
  sourceCode: string,
  segments: ClassifiedSegment[],
  componentProfiles?: Map<string, ComponentProfile>,
  reExportMap?: ReExportMap,
): LazyCandidateResult {
  const lazy: LazyCandidate[] = [];
  const keepStatic: LazyCandidateResult['keepStatic'] = [];

  // Step 0: Skip modules that don't export React components.
  // Entry points (e.g., main.tsx calling ReactDOM.render) have module-level JSX
  // but don't export components — lazy detection doesn't apply to them.
  if (!hasExportedComponent(analyzed.ast)) {
    return { lazy, keepStatic };
  }

  // Step 1: Find all component imports (PascalCase from relative paths)
  // Pass reExportMap to resolve through barrel files when available.
  const componentImports = findComponentImports(analyzed, reExportMap);
  if (componentImports.length === 0) {
    return { lazy, keepStatic };
  }

  // Step 2: Find JSX usages of each imported component
  const jsxUsageMap = findJSXUsages(analyzed.ast, componentImports.map((c) => c.localName));

  // Step 3: Detect which components are used as context providers
  const providerNames = detectContextProviders(analyzed.ast, componentImports.map((c) => c.localName));

  // Step 4: Determine if this module is a route-level component
  const isRouteComponent = checkIsRouteComponent(analyzed.path, analyzed.ast);

  // Step 5: Evaluate each component import
  for (const imp of componentImports) {
    const usages = jsxUsageMap.get(imp.localName);
    if (!usages || usages.length === 0) {
      // Imported but never used in JSX — skip (might be a utility, HOC, etc.)
      continue;
    }

    // Try resolved source first for profile lookup (barrel-resolved path),
    // fall back to original import source
    const profileSource = imp.resolvedSource ?? imp.source;
    const profile = resolveComponentProfile(profileSource, analyzed.path, componentProfiles) ?? null;
    const isProvider = providerNames.has(imp.localName);

    // Rule 1: Context providers must hydrate before consumers — never lazify
    if (isProvider) {
      keepStatic.push({
        localName: imp.localName,
        source: imp.source,
        reason: 'Context provider — must hydrate before consumers',
      });
      continue;
    }

    // Rule 2: If we have a profile and the component has no meaningful JS cost, skip
    if (profile && !hasSignificantJSCost(profile)) {
      keepStatic.push({
        localName: imp.localName,
        source: imp.source,
        reason: `Low JS cost (${profile.estimatedSize}B < ${MIN_JS_COST_BYTES}B threshold) — Suspense overhead exceeds savings`,
      });
      continue;
    }

    // Gather JSX context for each usage
    const positions = usages.map((u) => u.position);
    const minPosition = Math.min(...positions);
    const isConditional = usages.some((u) => u.conditional);
    const isOnlyConditional = usages.every((u) => u.conditional);

    // Rule 3: Components above the fold in route-level components should stay static.
    // Positions below BELOW_FOLD_POSITION (0, 1) are assumed to be in the initial viewport.
    // The Suspense boundary overhead and loading waterfall hurts LCP for above-fold content.
    if (isRouteComponent && minPosition < BELOW_FOLD_POSITION && !isOnlyConditional) {
      keepStatic.push({
        localName: imp.localName,
        source: imp.source,
        reason: `Position ${minPosition} in route component — above fold (threshold: ${BELOW_FOLD_POSITION})`,
      });
      continue;
    }

    // Assign prefetch strategy based on heuristics
    const prefetch = assignStrategy(minPosition, isOnlyConditional, isRouteComponent, profile);

    lazy.push({
      localName: imp.localName,
      source: imp.source,
      resolvedSource: imp.resolvedSource ?? undefined,
      importKind: imp.importKind,
      importedName: imp.importedName,
      jsxUsages: usages.map((u) => ({ start: u.start, end: u.end })),
      prefetch,
      suspenseGroup: null, // Heuristic: one boundary per component. LLM can optimize grouping.
      conditional: isConditional,
      jsxPosition: minPosition,
      reason: buildReason(minPosition, isOnlyConditional, prefetch, profile),
    });
  }

  // Step 6: Assign suspense groups for adjacent lazy components
  assignSuspenseGroups(lazy, analyzed.ast);

  return { lazy, keepStatic };
}

// ── Component import detection ──────────────────────────────────────────

interface ComponentImport {
  localName: string;
  /** Original import source as written in the module (for matching import declarations) */
  source: string;
  /** Resolved source after barrel file resolution (for the dynamic import target). Null if no resolution needed. */
  resolvedSource: string | null;
  importKind: 'default' | 'named' | 'namespace';
  /** The exported name from the source module (null for default imports) */
  importedName: string | null;
}

/**
 * Find imports that look like React component imports:
 * - PascalCase local name (components by convention)
 * - From a relative path (./Foo, ../components/Bar)
 * - Not from node_modules (bare specifiers like 'react')
 *
 * When a reExportMap is provided, resolves through barrel files:
 * if `import { PaymentForm } from './components'` and the barrel file
 * `./components/index.ts` re-exports `PaymentForm` from `./PaymentForm`,
 * the resolved source becomes `./components/PaymentForm`.
 */
function findComponentImports(
  analyzed: AnalyzedModule,
  reExportMap?: ReExportMap,
): ComponentImport[] {
  const results: ComponentImport[] = [];

  for (const imp of analyzed.imports) {
    // Only relative imports — node_modules components can't be lazified
    // without knowing their export shape
    if (!isRelativeImport(imp.source)) continue;

    for (const spec of imp.specifiers) {
      if (isPascalCase(spec.local)) {
        let resolvedSource: string | null = null;
        let importKind = spec.kind;
        let importedName = spec.imported;

        // Try to resolve through barrel files
        if (reExportMap && reExportMap.size > 0) {
          const resolved = resolveBarrelImport(
            imp.source, spec.imported ?? spec.local, spec.kind,
            analyzed.path, reExportMap,
          );
          if (resolved) {
            resolvedSource = resolved.source;
            importKind = resolved.importKind;
            importedName = resolved.importedName;
          }
        }

        results.push({
          localName: spec.local,
          source: imp.source,
          resolvedSource,
          importKind,
          importedName,
        });
      }
    }
  }

  return results;
}

/**
 * Resolve through a barrel file re-export.
 *
 * Given `import { PaymentForm } from './components'` where `./components/index.ts`
 * has `export { PaymentForm } from './PaymentForm'`, returns the resolved source
 * `./components/PaymentForm` so the lazy dynamic import targets the actual module.
 */
function resolveBarrelImport(
  importSource: string,
  importedName: string,
  importKind: 'default' | 'named' | 'namespace',
  modulePath: string,
  reExportMap: ReExportMap,
): { source: string; importKind: 'default' | 'named' | 'namespace'; importedName: string | null } | null {
  // Namespace imports can't resolve through barrel files
  if (importKind === 'namespace') return null;

  const dir = dirname(modulePath);

  // Try to find the barrel file in the re-export map
  // The map is keyed by absolute paths, so resolve the import source
  const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js', ''];
  let barrelMappings: Map<string, { source: string; importedName: string }> | undefined;
  let barrelDir: string | undefined;

  for (const ext of EXTENSIONS) {
    const candidate = resolve(dir, importSource + ext);
    barrelMappings = reExportMap.get(candidate);
    if (barrelMappings) {
      barrelDir = dirname(candidate);
      break;
    }
  }

  if (!barrelMappings || !barrelDir) return null;

  // Look for the exported name in the barrel's re-exports
  const lookupName = importKind === 'default' ? 'default' : importedName;
  const reExport = barrelMappings.get(lookupName);
  if (!reExport) return null;

  // Build the resolved source path relative to the importing module.
  // The re-export source is relative to the barrel file, so we need to
  // resolve it from the barrel's directory then make it relative to the importer.
  const absoluteTarget = resolve(barrelDir, reExport.source);
  let resolvedSource = makeRelative(dir, absoluteTarget);

  // Determine the import kind through the re-export
  const resolvedImportKind = reExport.importedName === 'default' ? 'default' as const : 'named' as const;
  const resolvedImportedName = resolvedImportKind === 'default' ? null : reExport.importedName;

  return { source: resolvedSource, importKind: resolvedImportKind, importedName: resolvedImportedName };
}

/**
 * Make a path relative, ensuring it starts with './' or '../'.
 */
function makeRelative(from: string, to: string): string {
  let rel = relative(from, to);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// ── JSX usage detection ─────────────────────────────────────────────────

interface JSXUsage {
  /** Byte offset of the JSX opening element */
  start: number;
  /** Byte offset of the JSX closing element (or self-closing end) */
  end: number;
  /** Index among sibling JSX elements in the parent container */
  position: number;
  /** Whether this usage is inside a conditional expression */
  conditional: boolean;
}

/**
 * Find all JSX element usages of the given component names.
 *
 * For each JSX element `<Foo ...>`, records:
 * - Its span in the source
 * - Its position among sibling elements in the parent
 * - Whether it appears inside a conditional context (&&, ternary, if)
 */
function findJSXUsages(
  ast: Node,
  componentNames: string[],
): Map<string, JSXUsage[]> {
  const nameSet = new Set(componentNames);
  const result = new Map<string, JSXUsage[]>();
  for (const name of componentNames) {
    result.set(name, []);
  }

  // Walk AST and collect JSX elements with parent context
  walkWithContext(ast, (node, context) => {
    if ((node.type as string) !== 'JSXElement') return;

    const jsx = node as unknown as {
      openingElement: {
        name: { type: string; name?: string };
      };
      start?: number;
      end?: number;
    };

    // Only handle simple identifier tags: <Foo /> not <foo.Bar />
    const tagName = jsx.openingElement?.name;
    if (!tagName || tagName.type !== 'JSXIdentifier') return;
    if (!tagName.name || !nameSet.has(tagName.name)) return;

    const start = (node as Node & { start?: number }).start ?? 0;
    const end = (node as Node & { end?: number }).end ?? 0;

    const usage: JSXUsage = {
      start,
      end,
      position: context.siblingIndex,
      conditional: context.isConditional,
    };

    result.get(tagName.name)!.push(usage);
  });

  return result;
}

// ── Context provider detection ──────────────────────────────────────────

/**
 * Detect which imported component names are used as context providers.
 *
 * Heuristics:
 * 1. Name ends with "Provider" or "Context" (convention)
 * 2. Used as a JSX element that wraps other JSX children
 *    (i.e., `<ThemeProvider>...children...</ThemeProvider>`)
 */
function detectContextProviders(
  ast: Node,
  componentNames: string[],
): Set<string> {
  const providers = new Set<string>();
  const nameSet = new Set(componentNames);

  // Heuristic 1: Name-based detection
  for (const name of componentNames) {
    if (PROVIDER_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      providers.add(name);
    }
  }

  // Heuristic 2: Structural detection — component has JSX children
  walkNode(ast, (node) => {
    if ((node.type as string) !== 'JSXElement') return;

    const jsx = node as unknown as {
      openingElement: { name: { type: string; name?: string } };
      children?: unknown[];
    };

    const tagName = jsx.openingElement?.name;
    if (!tagName || tagName.type !== 'JSXIdentifier') return;
    if (!tagName.name || !nameSet.has(tagName.name)) return;

    // Check if it has JSX children (not just text/whitespace)
    const hasJSXChildren = jsx.children?.some((child) => {
      const c = child as { type?: string };
      return (
        c.type === 'JSXElement' ||
        c.type === 'JSXFragment' ||
        c.type === 'JSXExpressionContainer'
      );
    });

    if (hasJSXChildren) {
      providers.add(tagName.name);
    }
  });

  return providers;
}

// ── Route component detection ───────────────────────────────────────────

/**
 * Check if this module exports a route-level component.
 *
 * Route components are where JSX position matters for above/below fold.
 * Detection heuristics:
 * 1. File path contains /pages/, /routes/, /app/, or /views/
 * 2. Component name matches route patterns (ends with Page, Layout, etc.)
 * 3. Is the default export of the module
 */
function checkIsRouteComponent(filePath: string, ast: Node): boolean {
  // Path-based heuristic
  const routePathPattern = /\/(pages?|routes?|app|views?|screens?)\//i;
  if (routePathPattern.test(filePath)) return true;

  // Name-based heuristic: check exported function/component names
  let hasRouteExport = false;
  walkNode(ast, (node) => {
    if (hasRouteExport) return;

    // export default function CheckoutPage() { ... }
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = (node as { declaration?: Node }).declaration;
      if (decl?.type === 'FunctionDeclaration') {
        const name = (decl as { id?: { name?: string } }).id?.name;
        if (name && ROUTE_COMPONENT_PATTERNS.test(name)) {
          hasRouteExport = true;
        }
      }
    }

    // export function CheckoutPage() { ... }
    if (node.type === 'ExportNamedDeclaration') {
      const decl = (node as { declaration?: Node }).declaration;
      if (decl?.type === 'FunctionDeclaration') {
        const name = (decl as { id?: { name?: string } }).id?.name;
        if (name && ROUTE_COMPONENT_PATTERNS.test(name)) {
          hasRouteExport = true;
        }
      }
    }
  });

  return hasRouteExport;
}

// ── Strategy assignment ─────────────────────────────────────────────────

/**
 * Assign a prefetch strategy based on heuristics.
 * This is the "80% programmatic" path — the LLM can override these
 * via the lockfile for the remaining 20% that needs judgment.
 */
function assignStrategy(
  jsxPosition: number,
  isConditional: boolean,
  isRouteComponent: boolean,
  profile: ComponentProfile | null,
): PrefetchStrategy {
  // Conditionally rendered components should load on interaction
  // (they might never be shown at all)
  if (isConditional) return 'interaction';

  // In a route component, position determines fold prediction
  if (isRouteComponent) {
    // Position 1 is borderline — use viewport so it loads as user scrolls
    if (jsxPosition === 1) return 'viewport';
    // Position 2+ is likely below fold
    if (jsxPosition >= BELOW_FOLD_POSITION) return 'viewport';
  }

  // If we have a profile with effects, the component probably needs
  // to initialize something — prefetch on idle so it's ready
  if (profile?.hasEffects) return 'idle';

  // Default: viewport-based loading
  return 'viewport';
}

// ── Suspense grouping ───────────────────────────────────────────────────

/**
 * Assign suspense groups to adjacent lazy components that share a parent.
 *
 * Without LLM input, the heuristic is simple:
 * Adjacent lazy components that are siblings in the same JSX parent
 * get grouped into one Suspense boundary. Non-adjacent siblings get
 * separate boundaries.
 *
 * The LLM can later optimize this by grouping components that share
 * state or are always used together.
 */
function assignSuspenseGroups(candidates: LazyCandidate[], ast: Node): void {
  if (candidates.length <= 1) return;

  // Build a map of JSX parent → ordered children info
  const parentGroups = new Map<string, LazyCandidate[]>();

  // For each candidate, find its parent JSX element
  for (const candidate of candidates) {
    for (const usage of candidate.jsxUsages) {
      const parentKey = findJSXParentKey(ast, usage.start, usage.end);
      if (!parentKey) continue;

      let group = parentGroups.get(parentKey);
      if (!group) {
        group = [];
        parentGroups.set(parentKey, group);
      }
      group.push(candidate);
    }
  }

  // For each parent, group adjacent candidates
  let groupCounter = 0;
  for (const [, group] of parentGroups) {
    if (group.length < 2) continue;

    // Sort by JSX position
    const sorted = [...group].sort((a, b) => a.jsxPosition - b.jsxPosition);

    // Find runs of adjacent positions
    let runStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const isEnd = i === sorted.length;
      const isBreak = !isEnd && sorted[i].jsxPosition !== sorted[i - 1].jsxPosition + 1;

      if (isEnd || isBreak) {
        // Run from runStart to i-1
        const runLength = i - runStart;
        if (runLength >= 2) {
          const groupId = `group_${groupCounter++}`;
          for (let j = runStart; j < i; j++) {
            sorted[j].suspenseGroup = groupId;
          }
        }
        runStart = i;
      }
    }
  }
}

/**
 * Find a stable key for the parent JSX element containing a child at [start, end].
 * Returns a string like "parentStart:parentEnd" or null if not found.
 */
function findJSXParentKey(ast: Node, childStart: number, childEnd: number): string | null {
  let parentKey: string | null = null;

  walkWithParentNode(ast, null, (node, parent) => {
    if (parentKey) return; // already found

    const nStart = (node as Node & { start?: number }).start;
    const nEnd = (node as Node & { end?: number }).end;
    if (nStart !== childStart || nEnd !== childEnd) return;

    if (parent) {
      const pStart = (parent as Node & { start?: number }).start;
      const pEnd = (parent as Node & { end?: number }).end;
      if (pStart != null && pEnd != null) {
        parentKey = `${pStart}:${pEnd}`;
      }
    }
  });

  return parentKey;
}

// ── Reason builder ──────────────────────────────────────────────────────

function buildReason(
  position: number,
  isConditional: boolean,
  strategy: PrefetchStrategy,
  profile: ComponentProfile | null,
): string {
  const parts: string[] = [];

  if (isConditional) {
    parts.push('conditionally rendered');
  }

  if (position >= BELOW_FOLD_POSITION) {
    parts.push(`position ${position} in render tree (likely below fold)`);
  }

  if (profile) {
    const details: string[] = [];
    if (profile.handlerCount > 0) details.push(`${profile.handlerCount} handlers`);
    if (profile.hasEffects) details.push('has effects');
    if (profile.estimatedSize > 0) details.push(`~${(profile.estimatedSize / 1024).toFixed(1)}KB`);
    if (details.length > 0) parts.push(details.join(', '));
  }

  parts.push(`strategy: ${strategy}`);
  return parts.join(' — ');
}

// ── Helpers ─────────────────────────────────────────────────────────────

function hasSignificantJSCost(profile: ComponentProfile): boolean {
  // A component must have substantial JS cost to justify the overhead of
  // a Suspense boundary + dynamic import chunk + loading waterfall step.
  // Handler extraction already moves expensive handler code to on-demand
  // chunks, and effects / state are cheap to keep inline — so we rely on
  // total estimated size as the sole gating signal.
  return profile.estimatedSize >= MIN_JS_COST_BYTES;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function isRelativeImport(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

/**
 * Resolve a component profile from the profiles map.
 *
 * Plugin.ts stores profiles keyed by absolute resolved file path (e.g.,
 * `/app/components/PaymentForm.tsx`), but import sources are relative
 * (e.g., `./PaymentForm`). This tries common extensions to find a match.
 */
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', ''];
function resolveComponentProfile(
  importSource: string,
  moduleFilePath: string,
  profiles?: Map<string, ComponentProfile>,
): ComponentProfile | undefined {
  if (!profiles || profiles.size === 0) return undefined;

  // Direct lookup (works when import source is already absolute/exact)
  if (profiles.has(importSource)) return profiles.get(importSource);

  // Resolve relative to the importing module's directory
  const dir = dirname(moduleFilePath);
  for (const ext of RESOLVE_EXTENSIONS) {
    const resolved = resolve(dir, importSource + ext);
    const profile = profiles.get(resolved);
    if (profile) return profile;
  }

  return undefined;
}

/**
 * Check if a module exports at least one React component.
 *
 * Entry points (e.g., main.tsx) typically call ReactDOM.render() at the
 * module level but don't export components. Lazy detection only applies
 * to modules that export components — otherwise we'd incorrectly try to
 * wrap top-level JSX (like `<App />`) in Suspense.
 *
 * Checks for:
 * - `export default function Foo() { ... }` (FunctionDeclaration)
 * - `export default () => ...` (ArrowFunctionExpression / FunctionExpression)
 * - `export function Foo() { ... }` (named export FunctionDeclaration)
 * - `export const Foo = () => ...` (named export with init)
 * - `export { Foo }` (named re-exports — conservative: assume component)
 */
function hasExportedComponent(ast: Node): boolean {
  let found = false;

  walkNode(ast, (node) => {
    if (found) return;

    if (node.type === 'ExportDefaultDeclaration') {
      const decl = (node as { declaration?: Node }).declaration;
      if (!decl) return;
      // export default function Foo() {}
      if (decl.type === 'FunctionDeclaration') { found = true; return; }
      // export default () => ... / export default function() {}
      if (decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') { found = true; return; }
      // export default Foo (identifier — could be component)
      if (decl.type === 'Identifier') { found = true; return; }
    }

    if (node.type === 'ExportNamedDeclaration') {
      const decl = (node as { declaration?: Node | null }).declaration;
      const specifiers = (node as { specifiers?: unknown[] }).specifiers;

      if (decl) {
        // export function Foo() {}
        if (decl.type === 'FunctionDeclaration') { found = true; return; }
        // export const Foo = () => ... or export const Foo = function() {}
        if (decl.type === 'VariableDeclaration') {
          const declarations = (decl as { declarations?: unknown[] }).declarations;
          if (declarations) {
            for (const d of declarations) {
              const vd = d as { id?: Node; init?: Node };
              // Check if the name is PascalCase (component convention)
              if (vd.id?.type === 'Identifier') {
                const name = (vd.id as Identifier).name;
                if (isPascalCase(name)) { found = true; return; }
              }
            }
          }
        }
      }

      // export { Foo } or export { Foo as Bar } — conservative: if any PascalCase name, assume component
      if (specifiers && specifiers.length > 0) {
        for (const spec of specifiers) {
          const s = spec as { exported?: { name?: string }; local?: { name?: string } };
          const exportedName = s.exported?.name ?? s.local?.name;
          if (exportedName && isPascalCase(exportedName)) { found = true; return; }
        }
      }
    }
  });

  return found;
}

// ── AST walkers ─────────────────────────────────────────────────────────

/**
 * Keys that are NOT AST children — skip to avoid circular references from
 * eslint-scope annotations and addASTMetadata patches.
 */
const SKIP_KEYS = new Set(['type', 'range', 'loc', 'start', 'end', 'parent', 'scope', 'raw', 'trailingComments', 'leadingComments', 'innerComments']);

/** Context tracked while walking JSX for usage detection */
interface WalkContext {
  /** Index among sibling JSX elements in the nearest parent container */
  siblingIndex: number;
  /** Whether this node is inside a conditional expression */
  isConditional: boolean;
}

/**
 * Walk AST tracking JSX-relevant context: sibling position and conditionality.
 */
function walkWithContext(
  node: unknown,
  callback: (node: Node, context: WalkContext) => void,
  context: WalkContext = { siblingIndex: 0, isConditional: false },
): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    // When iterating an array of JSX children, track sibling index
    // Count only JSXElement siblings (skip text, expressions, whitespace)
    let elementIndex = 0;
    for (const child of node) {
      const childObj = child as Record<string, unknown>;
      const isJSXElement = childObj?.type === 'JSXElement' || childObj?.type === 'JSXFragment';

      walkWithContext(child, callback, {
        ...context,
        siblingIndex: isJSXElement ? elementIndex : context.siblingIndex,
      });

      if (isJSXElement) elementIndex++;
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  if (typeof obj.type !== 'string') return;

  const asNode = obj as unknown as Node;
  callback(asNode, context);

  // Propagate conditionality into children of conditional expressions
  const isConditionalNode =
    obj.type === 'ConditionalExpression' ||
    (obj.type === 'LogicalExpression' && (obj.operator === '&&' || obj.operator === '||'));

  for (const key of Object.keys(obj)) {
    if (SKIP_KEYS.has(key)) continue;

    const childContext: WalkContext = {
      siblingIndex: context.siblingIndex,
      isConditional: context.isConditional || isConditionalNode,
    };

    // For JSXElement.children, reset sibling counting
    if (key === 'children' && (obj.type === 'JSXElement' || obj.type === 'JSXFragment')) {
      childContext.siblingIndex = 0;
    }

    walkWithContext(obj[key], callback, childContext);
  }
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
    if (SKIP_KEYS.has(key)) continue;
    walkNode(obj[key], callback);
  }
}

function walkWithParentNode(
  node: unknown,
  parent: Node | null,
  callback: (node: Node, parent: Node | null) => void,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkWithParentNode(child, parent, callback);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type !== 'string') return;
  const asNode = obj as unknown as Node;
  callback(asNode, parent);
  for (const key of Object.keys(obj)) {
    if (SKIP_KEYS.has(key)) continue;
    walkWithParentNode(obj[key], asNode, callback);
  }
}
