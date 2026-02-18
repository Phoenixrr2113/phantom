import { resolve, dirname } from 'node:path';
import type { ClassifiedSegment, AnalyzedModule, ImportInfo } from '../types.js';

export interface ImportResolution {
  /** Import statements needed in the chunk module */
  imports: ImportInfo[];
  /** Captured variables that become function parameters */
  capturedParams: string[];
}

/**
 * Resolve what the extracted segment needs: imports vs captured variables.
 *
 * ClassifiedSegment.dependencies merges fn.captured + fn.imported.
 * We recover the split by matching back to the FunctionDependency via span,
 * then cross-reference imported names against AnalyzedModule.imports.
 *
 * Relative import paths (./foo, ../bar) are rewritten to absolute paths
 * so that chunk virtual modules (which have no filesystem location) can
 * resolve their dependencies correctly.
 */
export function resolveImports(
  segment: ClassifiedSegment,
  analyzed: AnalyzedModule,
  sourceFilePath: string,
): ImportResolution {
  const fnDep = analyzed.functions.find(
    (fn) => fn.span.start === segment.span.start && fn.span.end === segment.span.end,
  );

  if (!fnDep) {
    return { imports: [], capturedParams: segment.dependencies };
  }

  const capturedParams = fnDep.captured;
  const importedNames = new Set(fnDep.imported);

  // Group needed imports by source module
  const importMap = new Map<string, ImportInfo>();
  const sourceDir = dirname(sourceFilePath);

  for (const imp of analyzed.imports) {
    for (const spec of imp.specifiers) {
      if (importedNames.has(spec.local)) {
        // Rewrite relative imports to absolute paths for virtual module resolution
        const resolvedSource = isRelativeImport(imp.source)
          ? resolve(sourceDir, imp.source)
          : imp.source;

        let entry = importMap.get(resolvedSource);
        if (!entry) {
          entry = { source: resolvedSource, specifiers: [] };
          importMap.set(resolvedSource, entry);
        }
        entry.specifiers.push(spec);
      }
    }
  }

  return {
    imports: Array.from(importMap.values()),
    capturedParams,
  };
}

/**
 * Check if an import specifier is a relative path (./foo or ../bar).
 * Bare specifiers like 'react' or '@org/pkg' are NOT relative.
 */
function isRelativeImport(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}
