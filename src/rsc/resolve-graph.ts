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
 * get-tsconfig, plus one-hop barrel resolution (`resolveEdge` / `resolveBarrelHop`,
 * reusing `resolveWithExtensions`). `buildComponentGraph` ties the classifier and
 * resolver together over a real directory and computes edge-resolution coverage.
 */

import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { getTsconfig, createPathsMatcher } from 'get-tsconfig';
import { parseModule } from '../analyzer.js';
import { classifyModuleRsc } from './classify-rsc.js';
import type { ReExportMapping, AnalyzedModule } from '../types.js';
import type { ComponentGraph, RscFileResult } from './types.js';

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

/** True when `file` is a barrel index module (`.../index.{tsx,ts,jsx,js}`). */
function isIndexFile(file: string): boolean {
  return /(^|\/)index\.(tsx|ts|jsx|js)$/.test(file);
}

/**
 * Follow ONE barrel hop. Given a resolved `barrelFile` (an index.*) that is the
 * target for `importedName`, look the name up in the barrel's re-exports and
 * resolve the originating module (relative to the barrel). Returns the concrete
 * file, or null if the name isn't re-exported there or can't be resolved.
 */
function resolveBarrelHop(
  barrelFile: string,
  importedName: string,
  reExportsByFile: ReadonlyMap<string, readonly ReExportMapping[]>,
  fileSet: ReadonlySet<string>,
  pathsMatcher?: PathsMatcher | null,
): string | null {
  const reExports = reExportsByFile.get(barrelFile);
  if (!reExports) return null;
  const match = reExports.find((r) => r.exportedName === importedName);
  if (!match) return null;
  return resolveImport(match.source, barrelFile, fileSet, pathsMatcher);
}

/**
 * Resolve an import EDGE to its concrete defining file, following one barrel hop
 * when the specifier resolves to an `index.*` that re-exports the imported name.
 * Falls back to the directly-resolved file (possibly the barrel itself) when no
 * precise hop exists, and null when nothing resolves. `importedName` is the
 * source export name (ImportInfo.specifier.imported); pass null for
 * default/namespace imports (no barrel hop attempted).
 */
export function resolveEdge(
  spec: string,
  fromFile: string,
  importedName: string | null,
  fileSet: ReadonlySet<string>,
  reExportsByFile: ReadonlyMap<string, readonly ReExportMapping[]>,
  pathsMatcher?: PathsMatcher | null,
): string | null {
  const direct = resolveImport(spec, fromFile, fileSet, pathsMatcher);
  if (!direct) return null;
  if (importedName && isIndexFile(direct)) {
    const hopped = resolveBarrelHop(direct, importedName, reExportsByFile, fileSet, pathsMatcher);
    if (hopped) return hopped;
  }
  return direct;
}

const SOURCE_EXT = /\.(tsx|ts|jsx|js)$/;
// Test/spec files don't ship, so they're excluded from the RSC migration map
// (otherwise they'd show up as noise in the 'use client' frontier).
const TEST_FILE = /\.(test|spec)\.(tsx|ts|jsx|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', '__tests__', '__mocks__']);
// Non-script asset/relative imports are real but are NOT RSC module edges; they
// must not count against edge-resolution coverage.
const ASSET_EXT = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|txt|graphql|gql|wasm|woff2?|ttf|eot|mp4|webm)$/i;

/** Recursively collect project source files (.tsx/.ts/.jsx/.js, excluding .d.ts). */
function walkProjectFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.d.ts') || TEST_FILE.test(entry.name)) continue;
        if (SOURCE_EXT.test(entry.name)) out.push(full);
      }
    }
  }
  return out;
}

/** tsconfig `paths` alias prefixes (e.g. "@/", "~/") used to recognize internal imports. */
function aliasPrefixesFor(dir: string): string[] {
  const tsconfig = getTsconfig(dir);
  const paths = tsconfig?.config?.compilerOptions?.paths;
  if (!paths) return [];
  return Object.keys(paths).map((k) => k.replace(/\*$/, ''));
}

/** Is this import specifier a project-internal module edge we should resolve + measure? */
function isCountableInternal(source: string, aliasPrefixes: string[]): boolean {
  if (ASSET_EXT.test(source)) return false; // asset, not a module edge
  if (source.startsWith('.')) return true; // relative
  return aliasPrefixes.some((p) => source.startsWith(p)); // tsconfig alias
}

/**
 * Build the resolved component import graph over `dir`: classify each source
 * file, resolve its internal import edges (relative + tsconfig alias + one-hop
 * barrel), and report `edgeResolution` = resolved / total internal module edges.
 * External (bare node_modules) and asset imports are excluded from the metric.
 */
export function buildComponentGraph(dir: string): ComponentGraph {
  const root = resolvePath(dir);
  const files = walkProjectFiles(root);
  const fileSet = new Set(files);
  const matcher = loadPathsMatcher(root);
  const aliasPrefixes = aliasPrefixesFor(root);

  // Parse + classify each file exactly once.
  const parsed = new Map<string, AnalyzedModule>();
  const results = new Map<string, RscFileResult>();
  const reExportsByFile = new Map<string, readonly ReExportMapping[]>();
  for (const file of files) {
    let code: string;
    try {
      code = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    let analyzed: AnalyzedModule;
    try {
      analyzed = parseModule(code, file);
    } catch {
      continue; // unparseable file — skip (still a resolvable target via fileSet)
    }
    parsed.set(file, analyzed);
    reExportsByFile.set(file, analyzed.reExports);
    results.set(file, classifyModuleRsc(analyzed, code));
  }

  // Resolve edges + measure coverage.
  let totalEdges = 0;
  let resolvedEdges = 0;
  for (const [file, analyzed] of parsed) {
    const result = results.get(file)!;
    const targets = new Set<string>();
    const localToTarget = new Map<string, string>();
    for (const imp of analyzed.imports) {
      if (!isCountableInternal(imp.source, aliasPrefixes)) continue;
      totalEdges++;
      // Metric: does the source resolve to a project file at all?
      if (resolveImport(imp.source, file, fileSet, matcher)) resolvedEdges++;
      // Precise edges (barrel-aware) per imported name. `export *` barrels are not
      // captured by the extractor, so such edges fall back to the barrel index file
      // rather than the true defining module — a known precision limit, not a miss.
      for (const spec of imp.specifiers) {
        const target = resolveEdge(imp.source, file, spec.imported, fileSet, reExportsByFile, matcher);
        if (target) {
          targets.add(target);
          localToTarget.set(spec.local, target);
        }
      }
    }
    result.imports = [...targets];
    result.importedComponents = localToTarget;
  }

  const edgeResolution = totalEdges === 0 ? 1 : resolvedEdges / totalEdges;
  return { files: results, edgeResolution };
}
