import type { ClassifiedSegment, AnalyzedModule, ImportInfo } from '../types.js';

export interface ImportResolution {
  /** Import statements needed in the server module */
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
 */
export function resolveImports(
  segment: ClassifiedSegment,
  analyzed: AnalyzedModule,
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

  for (const imp of analyzed.imports) {
    for (const spec of imp.specifiers) {
      if (importedNames.has(spec.local)) {
        let entry = importMap.get(imp.source);
        if (!entry) {
          entry = { source: imp.source, specifiers: [] };
          importMap.set(imp.source, entry);
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
