/**
 * Import-graph resolver for the RSC readiness pipeline.
 *
 * The first and most correctness-critical unit of the contagion engine: a
 * missed import edge silently under-propagates client-ness, which over-reports
 * server-eligibility (an unsafe error). Pure function over an in-memory file
 * set — no filesystem access — so it is exhaustively testable.
 *
 * This task handles RELATIVE imports only. Alias and barrel resolution are
 * added to this same file in later tasks and reuse `resolveWithExtensions`.
 */

import { dirname, resolve as resolvePath } from 'node:path';

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const;

/**
 * Resolve a base path (no extension assumed) to a concrete file in the project
 * file set, trying bare extensions then `/index.*` variants. Module-private —
 * reused by alias/barrel resolution in later tasks.
 */
function resolveWithExtensions(base: string, fileSet: ReadonlySet<string>): string | null {
  if (fileSet.has(base)) return base; // import included an explicit extension
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (fileSet.has(candidate)) return candidate;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${base}/index${ext}`;
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a *relative* import specifier (`./x`, `../y`) from `fromFile` to a
 * concrete absolute file path present in `fileSet`. Returns null for non-relative
 * specifiers (bare modules, tsconfig aliases) and for unresolved relatives.
 */
export function resolveImport(
  spec: string,
  fromFile: string,
  fileSet: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolvePath(dirname(fromFile), spec);
  return resolveWithExtensions(base, fileSet);
}
