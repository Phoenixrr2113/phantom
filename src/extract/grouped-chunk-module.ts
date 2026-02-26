import { createHash } from 'node:crypto';
import type { ClassifiedSegment, ImportInfo, SourceMapLike } from '../types.js';
import type { ExtractableNode } from './client-stub.js';
import { buildHandlerExportAST, buildImportDeclarations } from './chunk-module.js';
import { print } from 'esrap';
import tsx from 'esrap/languages/tsx';
import type { Program } from 'estree';

// ── Types ────────────────────────────────────────────────────────────────

export interface GroupedHandlerInput {
  segment: ClassifiedSegment;
  astNode: ExtractableNode;
  imports: ImportInfo[];
  capturedParams: string[];
}

// ── Group ID generation ──────────────────────────────────────────────────

/**
 * Generate a deterministic group ID from the source file path.
 *
 * Uses SHA-256 of the file path, truncated to 12 hex chars.
 * Format: `grp_<12-char-hex>`
 */
export function generateGroupId(sourceFilePath: string): string {
  const hash = createHash('sha256').update(sourceFilePath).digest('hex').slice(0, 12);
  return `grp_${hash}`;
}

// ── Import deduplication ─────────────────────────────────────────────────

/**
 * Deduplicate imports across multiple handlers.
 *
 * When multiple handlers in the same file import from the same source,
 * we merge them into a single import declaration. This prevents duplicate
 * import statements in the grouped module.
 *
 * Example:
 *   Handler A: import { validate } from '/abs/utils';
 *   Handler B: import { format } from '/abs/utils';
 *   Result:    import { validate, format } from '/abs/utils';
 */
function deduplicateImports(allImports: ImportInfo[][]): ImportInfo[] {
  // Map from source → merged ImportInfo
  const sourceMap = new Map<string, ImportInfo>();

  for (const imports of allImports) {
    for (const imp of imports) {
      const existing = sourceMap.get(imp.source);
      if (!existing) {
        // Deep copy to avoid mutating the original
        sourceMap.set(imp.source, {
          source: imp.source,
          specifiers: [...imp.specifiers],
        });
      } else {
        // Merge specifiers, deduplicating by local name
        const existingLocals = new Set(existing.specifiers.map((s) => s.local));
        for (const spec of imp.specifiers) {
          if (!existingLocals.has(spec.local)) {
            existing.specifiers.push(spec);
            existingLocals.add(spec.local);
          }
        }
      }
    }
  }

  return [...sourceMap.values()];
}

// ── Grouped chunk module generation ──────────────────────────────────────

/**
 * Generate a single chunk module containing multiple exported handler functions.
 *
 * Groups all handlers extracted from the same source file into one ES module,
 * reducing the number of chunks from N to 1 per source file.
 *
 * Output shape:
 *
 *   import { validate } from '/abs/path/utils';
 *   import { format } from 'date-fns';
 *
 *   export function seg_abc123(e) { ... }
 *   export function seg_def456(e, inputRef) { ... }
 *   export function seg_ghi789() { ... }
 */
export function generateGroupedChunkModule(
  handlers: GroupedHandlerInput[],
  sourceFilePath: string,
  sourceCode: string,
): { code: string; map: SourceMapLike } {
  const body: Program['body'] = [];

  // 1. Deduplicated import declarations across all handlers
  const mergedImports = deduplicateImports(handlers.map((h) => h.imports));
  body.push(...buildImportDeclarations(mergedImports));

  // 2. Exported functions — one per handler
  for (const handler of handlers) {
    body.push(buildHandlerExportAST(handler.segment, handler.astNode, handler.capturedParams));
  }

  // 3. Generate code with esrap
  const program: Program = {
    type: 'Program',
    sourceType: 'module',
    body,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- esrap tsx visitors expect TSESTree.Node, our estree is compatible at runtime
  const result = print(program as any, tsx() as any, {
    sourceMapSource: sourceFilePath,
    sourceMapContent: sourceCode,
  });
  return { code: result.code, map: result.map };
}
