/**
 * Import-graph resolver for the RSC readiness pipeline.
 *
 * The first and most correctness-critical unit of the contagion engine: a
 * missed import edge silently under-propagates client-ness, which over-reports
 * server-eligibility (an unsafe error). `resolveImport` is a pure function over
 * an in-memory file set, so it is exhaustively testable; the only filesystem
 * access is `loadPathsMatcher`, which is built once per project and reused.
 *
 * Handles relative imports and tsconfig path aliases (`@/*`, `~/*`, etc.) via
 * get-tsconfig. Barrel resolution is added to this same file in a later task and
 * reuses `resolveWithExtensions`.
 */

import { dirname, resolve as resolvePath } from 'node:path';
import { getTsconfig, createPathsMatcher } from 'get-tsconfig';

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const;

/** Maps an import specifier to candidate base paths (absolute, no extension). */
export type PathsMatcher = (specifier: string) => string[];

/**
 * Load the nearest tsconfig to `fromDir` and build a matcher for its
 * `compilerOptions.paths` aliases (and `baseUrl`, if set). Returns null when
 * there is no tsconfig or it declares no path/baseUrl resolution.
 *
 * Reads the filesystem (NOT pure) — call once per project and reuse the matcher
 * across `resolveImport` calls.
 */
export function loadPathsMatcher(fromDir: string): PathsMatcher | null {
  const tsconfig = getTsconfig(fromDir);
  if (!tsconfig) return null;
  return createPathsMatcher(tsconfig);
}

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
 * Resolve an import specifier from `fromFile` to a concrete absolute file path
 * present in `fileSet`.
 *
 * Relative specifiers (`./x`, `../y`) resolve against `fromFile`'s directory.
 * Non-relative specifiers are resolved only when a `pathsMatcher` is supplied
 * (from {@link loadPathsMatcher}): each candidate base the matcher yields is run
 * through the same extension/index resolution as relatives. Bare modules with no
 * matching alias (and all specifiers with no on-disk file in `fileSet`) return null.
 *
 * Pure: the filesystem read lives in `loadPathsMatcher`, not here.
 */
export function resolveImport(
  spec: string,
  fromFile: string,
  fileSet: ReadonlySet<string>,
  pathsMatcher?: PathsMatcher | null,
): string | null {
  if (spec.startsWith('.')) {
    const base = resolvePath(dirname(fromFile), spec);
    return resolveWithExtensions(base, fileSet);
  }
  if (pathsMatcher) {
    for (const candidateBase of pathsMatcher(spec)) {
      const resolved = resolveWithExtensions(candidateBase, fileSet);
      if (resolved) return resolved;
    }
  }
  return null;
}
