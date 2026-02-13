import { parseSync } from 'oxc-parser';
import { analyze as analyzeScope } from 'eslint-scope';
import type { Program, Node } from 'estree';
import { addRanges } from './ast-compat.js';
import { classifyModule } from './classify/index.js';
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

  const ast = parseResult.program as unknown as Program;

  // 2. Patch AST for eslint-scope compatibility (add range: [start, end])
  addRanges(ast);

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

  // ArrowFunctionExpression or FunctionExpression assigned to a variable
  // The parent context would need to be tracked for this, so for now
  // we return "<anonymous>" and can improve later
  return '<anonymous>';
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

  // Phase 4: extraction (not yet implemented)
  const hasServerExtractions = segments.some(
    (s) => s.classification === 'ServerCompute',
  );

  return {
    path,
    segments,
    hasServerExtractions,
  };
}
