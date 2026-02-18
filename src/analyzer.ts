import { parseSync } from 'oxc-parser';
import { analyze as analyzeScope } from 'eslint-scope';
import type { Program, Node } from 'estree';
import { addASTMetadata } from './ast-compat.js';
import { classifyModule } from './classify/index.js';
import { extractModule } from './extract/index.js';
import type {
  AnalyzedModule,
  AnalysisResult,
  FunctionDependency,
  ImportInfo,
  PhantomPluginOptions,
} from './types.js';

/**
 * Determine the OXC parser `lang` option from a file path.
 */
function getLang(path: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.jsx')) return 'jsx';
  return 'js';
}

/**
 * Parse a module and perform scope analysis.
 * Returns the AST, function dependency info, and import info.
 */
export function parseModule(code: string, path: string): AnalyzedModule {
  // 1. Parse with OXC
  const parseResult = parseSync(path, code, {
    lang: getLang(path),
    sourceType: 'module',
    astType: 'js', // ESTree-compatible output (strips TS-specific nodes)
  });

  // Bail early on parse errors — partial ASTs cause cryptic downstream failures
  if (parseResult.errors.length > 0) {
    const errMsg = parseResult.errors.map((e: { message: string }) => e.message).join(', ');
    throw new Error(`[phantom] Parse errors in ${path}: ${errMsg}`);
  }

  const ast = parseResult.program as unknown as Program;

  // 2. Patch AST for eslint-scope + esrap (add range + loc)
  addASTMetadata(ast, code);

  // 3. Run eslint-scope for scope/symbol resolution
  // eslint-scope supports `jsx` but the type definitions don't declare it
  const scopeManager = analyzeScope(ast, {
    ecmaVersion: 2022,
    sourceType: 'module',
    jsx: true,
    fallback: 'iteration',
  } as Record<string, unknown>);

  // 4. Extract import information from OXC's module info
  const imports = extractImports(parseResult);

  // 5. Build function dependency map from scope analysis
  const functions = buildFunctionDependencies(scopeManager);

  // 6. Resolve names for anonymous functions from assignment context
  resolveAnonymousNames(ast, functions);

  return { path, ast, functions, imports };
}

/**
 * Extract import information from OXC's parsed module info.
 */
function extractImports(parseResult: ReturnType<typeof parseSync>): ImportInfo[] {
  const moduleInfo = parseResult.module;
  if (!moduleInfo) return [];

  return moduleInfo.staticImports.map((imp) => ({
    source: imp.moduleRequest.value,
    specifiers: imp.entries.map((entry) => ({
      local: entry.localName.value,
      imported: entry.importName.kind === 'Name'
        ? (entry.importName.name ?? null)
        : null,
      kind: entry.importName.kind === 'Default'
        ? 'default' as const
        : entry.importName.kind === 'NamespaceObject'
          ? 'namespace' as const
          : 'named' as const,
    })),
  }));
}

/**
 * Build function dependency information from eslint-scope's analysis.
 *
 * For each function scope, we determine:
 * - locals: variables declared in this function
 * - captured: variables referenced from outer scopes
 * - imported: variables that trace back to import declarations
 * - globals: unresolved references (browser globals, etc.)
 */
function buildFunctionDependencies(
  scopeManager: ReturnType<typeof analyzeScope>,
): FunctionDependency[] {
  const results: FunctionDependency[] = [];

  // Collect all import-declared variable names at module scope
  const importedNames = new Set<string>();
  const moduleScope = scopeManager.scopes.find((s) => s.type === 'module');
  if (moduleScope) {
    for (const variable of moduleScope.variables) {
      // Variables with ImportBinding definitions are imports
      const isImport = variable.defs.some(
        (d) => d.type === 'ImportBinding',
      );
      if (isImport) {
        importedNames.add(variable.name);
      }
    }
  }

  for (const scope of scopeManager.scopes) {
    // Only process function-like scopes
    if (scope.type !== 'function') continue;

    const block = scope.block as Node & { start?: number; end?: number };
    const name = getFunctionName(block);

    const locals: string[] = [];
    const captured: string[] = [];
    const imported: string[] = [];
    const globals: string[] = [];

    // Local variables are those declared in this scope
    for (const variable of scope.variables) {
      if (variable.name === 'arguments') continue; // skip implicit `arguments`
      locals.push(variable.name);
    }

    // "through" references are those not resolved in this scope
    // They might be captured from parent, imported, or truly global
    for (const ref of scope.through) {
      const refName = ref.identifier.name;

      if (importedNames.has(refName)) {
        if (!imported.includes(refName)) {
          imported.push(refName);
        }
      } else if (ref.resolved) {
        // Resolved to an outer scope variable → captured
        if (!captured.includes(refName)) {
          captured.push(refName);
        }
      } else {
        // Unresolved → global (browser API, etc.)
        if (!globals.includes(refName)) {
          globals.push(refName);
        }
      }
    }

    // Also check references that ARE resolved but point to outer scopes
    for (const ref of scope.references) {
      const refName = ref.identifier.name;
      if (ref.resolved && !locals.includes(refName) && !importedNames.has(refName)) {
        if (!captured.includes(refName)) {
          captured.push(refName);
        }
      }
    }

    results.push({
      name,
      locals,
      captured,
      imported,
      globals,
      span: {
        start: block.start ?? 0,
        end: block.end ?? 0,
      },
    });
  }

  return results;
}

/**
 * Extract a human-readable name for a function AST node.
 */
function getFunctionName(node: Node): string {
  // FunctionDeclaration with an id
  if (node.type === 'FunctionDeclaration' && 'id' in node && node.id) {
    return (node.id as { name: string }).name;
  }

  // FunctionExpression with an id (e.g., const x = function foo() {})
  if (node.type === 'FunctionExpression' && 'id' in node && node.id) {
    return (node.id as { name: string }).name;
  }

  return '<anonymous>';
}

/**
 * Resolve names for anonymous functions from their assignment context.
 *
 * After building FunctionDependency[], walk the AST to find:
 * - `const foo = () => {}` → name is `foo` (VariableDeclarator parent)
 * - `const foo = function() {}` → name is `foo` (VariableDeclarator parent)
 * - `{ key: () => {} }` → name is the property key
 *
 * Matches functions to FunctionDependency entries by span (start/end).
 */
function resolveAnonymousNames(
  ast: Program,
  functions: FunctionDependency[],
): void {
  // Build a quick lookup from span → FunctionDependency for anonymous functions
  const anonBySpan = new Map<string, FunctionDependency>();
  for (const fn of functions) {
    if (fn.name === '<anonymous>') {
      anonBySpan.set(`${fn.span.start}:${fn.span.end}`, fn);
    }
  }
  if (anonBySpan.size === 0) return;

  walkWithParent(ast, null, (node, parent) => {
    if (!isFunctionNode(node)) return;

    const nStart = (node as Node & { start?: number }).start;
    const nEnd = (node as Node & { end?: number }).end;
    if (nStart == null || nEnd == null) return;

    const key = `${nStart}:${nEnd}`;
    const fn = anonBySpan.get(key);
    if (!fn) return;

    // Case 1: VariableDeclarator — `const foo = () => {}`
    if (parent && parent.type === 'VariableDeclarator' && 'id' in parent) {
      const id = parent.id as Node;
      if (id.type === 'Identifier' && 'name' in id) {
        fn.name = id.name as string;
        anonBySpan.delete(key);
        return;
      }
    }

    // Case 2: Property / ObjectProperty — `{ key: () => {} }`
    if (parent && (parent.type === 'Property' || (parent.type as string) === 'ObjectProperty')) {
      const propKey = (parent as unknown as Record<string, unknown>).key as Node | undefined;
      if (propKey && propKey.type === 'Identifier' && 'name' in propKey) {
        fn.name = propKey.name as string;
        anonBySpan.delete(key);
        return;
      }
    }
  });
}

function isFunctionNode(node: Node): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression'
  );
}

/**
 * Walk AST nodes, passing each node and its parent to the callback.
 */
function walkWithParent(
  node: unknown,
  parent: Node | null,
  callback: (node: Node, parent: Node | null) => void,
): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) {
      walkWithParent(child, parent, callback);
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  if (typeof obj.type !== 'string') return;

  const asNode = obj as unknown as Node;
  callback(asNode, parent);

  for (const key of Object.keys(obj)) {
    if (key === 'type') continue;
    walkWithParent(obj[key], asNode, callback);
  }
}

/**
 * Analyze a single module: parse → scope analysis → classify → extract.
 */
export function analyzeModule(
  code: string,
  path: string,
  _options?: PhantomPluginOptions,
): AnalysisResult {
  const parsed = parseModule(code, path);

  // Phase 3: classification
  const segments = classifyModule(parsed, code);

  // Phase 4: extraction
  const confidenceThreshold = _options?.confidenceThreshold ?? 0.8;
  const extracted = extractModule(parsed, segments, code, confidenceThreshold, path);

  if (extracted) {
    return {
      path,
      segments,
      hasExtractions: true,
      clientCode: extracted.clientCode,
      clientMap: extracted.clientMap,
      chunkModules: extracted.chunkModules,
    };
  }

  return {
    path,
    segments,
    hasExtractions: false,
  };
}
