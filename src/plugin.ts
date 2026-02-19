import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createUnplugin } from 'unplugin';
import type {
  AnalysisResult,
  AnalyzedModule,
  ClassifiedSegment,
  ComponentProfile,
  LazyCandidate,
  ManifestEntry,
  PhantomManifest,
  PhantomPluginOptions,
  PrefetchStrategy,
  SSRModuleResult,
  SourceMapLike,
} from './types.js';
import { parseModule } from './analyzer.js';
import {
  classifyModule,
  classifyModuleWithContext,
  classifyModuleSSR,
  detectLazyCandidates,
} from './classify/index.js';
import type { ClassificationContext } from './classify/index.js';
import { extractModule } from './extract/index.js';
import { refineLazyCandidatesBatched } from './classify/llm-client.js';

/** Prefix for Phantom virtual chunk modules */
export const VIRTUAL_PREFIX = '\0phantom:';

/** Public prefix used in import statements (before resolution) */
export const PUBLIC_PREFIX = 'phantom:';

// ── LLM batch queue types ─────────────────────────────────────────────

/**
 * A module waiting for the batched LLM call to resolve.
 * Stores everything needed to re-run extraction with refined candidates.
 */
interface PendingLazyModule {
  id: string;
  code: string;
  parsed: AnalyzedModule;
  segments: ClassifiedSegment[];
  lazyCandidates: LazyCandidate[];
  lazyKeptStatic: Array<{ localName: string; source: string; reason: string }>;
  /** The heuristic result — used as fallback if LLM fails */
  heuristicResult: AnalysisResult;
  resolve: (result: AnalysisResult) => void;
}

/**
 * Per-module stash of lazy candidate data for the LLM batch.
 */
interface LazyModuleStash {
  candidates: LazyCandidate[];
  keepStatic: Array<{ localName: string; source: string; reason: string }>;
  parentComponent: string;
  componentProfiles: Map<string, ComponentProfile> | undefined;
  /** Hash of the source code for cache invalidation */
  codeHash: string;
}

/**
 * Serializable cache entry for a single module's LLM-refined decisions.
 */
interface CachedLazyDecision {
  localName: string;
  prefetch: PrefetchStrategy;
  suspenseGroup: string | null;
  reason: string;
}

interface LazyCacheEntry {
  codeHash: string;
  decisions: CachedLazyDecision[];
  movedToStatic: string[];
}

interface LazyRefinementCache {
  version: 1;
  entries: Record<string, LazyCacheEntry>;
}

/**
 * Default debounce window (ms) for collecting transforms before firing the LLM call.
 * Transforms arriving within this window after the last transform are batched together.
 * For an LLM call that takes 1-3 seconds, 50ms of collection overhead is negligible.
 */
const LLM_BATCH_DEBOUNCE_MS = 50;

export const phantom = createUnplugin((options: PhantomPluginOptions = {}) => {
  // ── Shared state accumulated across transform calls ──────────────────
  const chunkModuleMap = new Map<string, { code: string; map: SourceMapLike }>();
  const manifestEntries: ManifestEntry[] = [];
  /** Reverse map: source file → virtual IDs it produced (for HMR cleanup) */
  const sourceToChunks = new Map<string, string[]>();
  /** Cross-module component profiles for lazy detection (accumulated during transform) */
  const componentProfiles = new Map<string, ComponentProfile>();
  /**
   * Re-export map: resolves barrel file imports to their actual source.
   * Key: absolute path of the barrel file.
   * Value: map of exported name → { source (relative), importedName }.
   */
  const reExportMap = new Map<string, Map<string, { source: string; importedName: string }>>();
  /** SSR boundary analysis results (accumulated when ssrBoundaries is enabled) */
  const ssrBoundaryResults = new Map<string, SSRModuleResult>();
  let moduleCount = 0;
  let modulesWithExtractions = 0;

  /** LLM refinement cache loaded from disk at buildStart */
  let refinementCache: LazyRefinementCache | null = null;

  // ── DataLoader-style LLM batch queue ────────────────────────────────
  // Multiple concurrent transform() calls enqueue here. After a debounce
  // period with no new arrivals, a single batched LLM call is fired.
  // All waiting transforms share the same Promise.

  let pendingModules: PendingLazyModule[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let batchPromise: Promise<void> | null = null;
  let batchResolve: (() => void) | null = null;

  /** Lazy stash for the buildEnd manifest/cache update — accumulated as transforms complete */
  const lazyStash = new Map<string, LazyModuleStash>();

  function getCachePath(): string {
    const manifestPath = options.manifestPath ?? 'phantom.manifest.json';
    return manifestPath.replace(/\.json$/, '.lazy-cache.json');
  }

  /**
   * Enqueue a module for batched LLM refinement.
   * Returns a Promise that resolves with the LLM-refined AnalysisResult
   * (or the heuristic result if LLM fails).
   */
  function enqueueLLMBatch(pending: Omit<PendingLazyModule, 'resolve'>): Promise<AnalysisResult> {
    return new Promise<AnalysisResult>((resolve) => {
      pendingModules.push({ ...pending, resolve });

      // Reset the debounce timer — extend the collection window
      if (batchTimer !== null) {
        clearTimeout(batchTimer);
      }

      // Create the shared batch promise if this is the first arrival
      if (!batchPromise) {
        batchPromise = new Promise<void>((r) => { batchResolve = r; });
      }

      // Use microtask for single-module flushes (e.g., HMR) to avoid
      // the 50ms debounce penalty when no other modules are arriving.
      // If a second module arrives before the microtask fires, we switch
      // to the debounce timer for proper batching.
      if (pendingModules.length === 1) {
        queueMicrotask(() => {
          // Only flush if no other modules have arrived (still just 1)
          if (pendingModules.length === 1 && batchTimer !== null) {
            clearTimeout(batchTimer);
            flushLLMBatch();
          }
        });
      }

      batchTimer = setTimeout(() => {
        flushLLMBatch();
      }, LLM_BATCH_DEBOUNCE_MS);
    });
  }

  /**
   * Flush the pending batch: fire ONE LLM call, then resolve all waiting transforms.
   */
  async function flushLLMBatch(): Promise<void> {
    const batch = pendingModules;
    const resolveAll = batchResolve;
    pendingModules = [];
    batchTimer = null;
    batchPromise = null;
    batchResolve = null;

    if (batch.length === 0) {
      resolveAll?.();
      return;
    }

    // Build the stash for the LLM call
    const moduleStash = new Map<string, {
      candidates: LazyCandidate[];
      keepStatic: Array<{ localName: string; source: string; reason: string }>;
      parentComponent: string;
      componentProfiles: Map<string, ComponentProfile> | undefined;
    }>();

    for (const mod of batch) {
      moduleStash.set(mod.id, {
        candidates: mod.lazyCandidates,
        keepStatic: mod.lazyKeptStatic,
        parentComponent: inferComponentName(mod.id),
        componentProfiles,
      });
    }

    if (!options.silent) {
      const totalCandidates = batch.reduce((sum, m) => sum + m.lazyCandidates.length, 0);
      console.log(
        `[phantom] Running LLM refinement: ${totalCandidates} candidates from ${batch.length} module(s)`,
      );
    }

    // Single batched LLM call
    const { results, globalInsights } = await refineLazyCandidatesBatched(
      moduleStash,
      options.cerebrasApiKey!,
      options.cerebrasModel,
      options.confidenceThreshold,
    );

    if (!options.silent && globalInsights.length > 0) {
      const lines = [`  LLM insights:`];
      for (const insight of globalInsights) {
        lines.push(`    - ${insight}`);
      }
      console.log(lines.join('\n'));
    }

    // Resolve each waiting transform with LLM-refined results
    const confidenceThreshold = options.confidenceThreshold ?? 0.8;

    for (const mod of batch) {
      const llmResult = results.get(mod.id);

      if (!llmResult) {
        // LLM returned nothing for this module — use heuristic
        mod.resolve(mod.heuristicResult);
        continue;
      }

      const refinedCandidates = llmResult.updated;
      const movedToStatic = llmResult.movedToStatic;

      // If LLM moved some candidates to static or changed strategies,
      // re-run extraction with refined candidates to get correct AST output
      const candidatesChanged = hasLLMChanges(
        mod.lazyCandidates,
        refinedCandidates,
        movedToStatic,
      );

      if (!candidatesChanged) {
        // LLM confirmed all heuristic decisions — use the already-computed result
        mod.resolve(mod.heuristicResult);
        continue;
      }

      // Re-run extraction with refined candidates
      const extracted = extractModule(
        mod.parsed,
        mod.segments,
        mod.code,
        confidenceThreshold,
        mod.id,
        refinedCandidates.length > 0 ? refinedCandidates : undefined,
      );

      if (extracted) {
        mod.resolve({
          path: mod.id,
          segments: mod.segments,
          hasExtractions: true,
          clientCode: extracted.clientCode,
          clientMap: extracted.clientMap,
          chunkModules: extracted.chunkModules,
          lazyCandidates: refinedCandidates.length > 0 ? refinedCandidates : undefined,
          lazyKeptStatic: [
            ...mod.lazyKeptStatic,
            ...movedToStatic,
          ],
        });
      } else {
        // Extraction returned null — fall back to heuristic
        mod.resolve(mod.heuristicResult);
      }
    }

    // Write refinement cache for subsequent builds
    writeLLMCache(batch, results);

    resolveAll?.();
  }

  /**
   * Write the LLM refinement cache so subsequent builds can skip the LLM call.
   */
  function writeLLMCache(
    batch: PendingLazyModule[],
    results: Map<string, {
      updated: LazyCandidate[];
      movedToStatic: Array<{ localName: string; source: string; reason: string }>;
      insights: string[];
    }>,
  ): void {
    const cachePath = getCachePath();
    // Load existing cache to merge (other modules may already be cached)
    let existingCache: LazyRefinementCache = { version: 1, entries: {} };
    try {
      if (existsSync(cachePath)) {
        const raw = readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as LazyRefinementCache;
        if (parsed.version === 1) {
          existingCache = parsed;
        }
      }
    } catch {
      // Ignore
    }

    for (const mod of batch) {
      const llmResult = results.get(mod.id);
      if (!llmResult) continue;

      existingCache.entries[mod.id] = {
        codeHash: hashCode(mod.code),
        decisions: llmResult.updated.map((c) => ({
          localName: c.localName,
          prefetch: c.prefetch,
          suspenseGroup: c.suspenseGroup,
          reason: c.reason,
        })),
        movedToStatic: llmResult.movedToStatic.map((m) => m.localName),
      };
    }

    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(existingCache, null, 2));
    } catch {
      // Cache write failure is non-fatal
    }
  }

  return {
    name: 'phantom',
    enforce: 'pre' as const,

    // Reset state on each build cycle (critical for watch/HMR mode)
    buildStart() {
      // SSR mode: no state needed — transforms are skipped
      if (options.ssr) return;

      chunkModuleMap.clear();
      manifestEntries.length = 0;
      sourceToChunks.clear();
      componentProfiles.clear();
      reExportMap.clear();
      lazyStash.clear();
      ssrBoundaryResults.clear();
      pendingModules = [];
      if (batchTimer !== null) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      batchPromise = null;
      batchResolve = null;
      moduleCount = 0;
      modulesWithExtractions = 0;

      // Load LLM refinement cache if it exists and an API key is configured
      refinementCache = null;
      if (options.cerebrasApiKey) {
        const cachePath = getCachePath();
        try {
          if (existsSync(cachePath)) {
            const raw = readFileSync(cachePath, 'utf-8');
            const parsed = JSON.parse(raw) as LazyRefinementCache;
            if (parsed.version === 1) {
              refinementCache = parsed;
            }
          }
        } catch {
          // Cache read failure is non-fatal
        }
      }
    },

    transformInclude(id: string) {
      return /\.[jt]sx?$/.test(id) && !id.includes('node_modules');
    },

    async transform(code: string, id: string) {
      // SSR mode: skip all transforms — server bundle needs original code
      // for synchronous renderToString()
      if (options.ssr) return null;

      moduleCount++;

      // HMR cleanup: remove stale chunks from a previous transform of this file
      const oldChunks = sourceToChunks.get(id);
      if (oldChunks) {
        for (const virtualId of oldChunks) {
          chunkModuleMap.delete(virtualId);
        }
        // Remove stale manifest entries for this source file
        for (let i = manifestEntries.length - 1; i >= 0; i--) {
          if (manifestEntries[i].sourceFile === id) {
            manifestEntries.splice(i, 1);
          }
        }
        sourceToChunks.delete(id);
      }
      lazyStash.delete(id);
      ssrBoundaryResults.delete(id);

      // ── Phase 1: Parse + classify (always synchronous) ──────────────
      let parsed: AnalyzedModule;
      let segments: ClassifiedSegment[];
      let classificationContext: ClassificationContext | undefined;
      try {
        parsed = parseModule(code, id);
        if (options.ssrBoundaries) {
          // Use the context-returning variant so SSR analysis reuses intermediate results
          classificationContext = classifyModuleWithContext(parsed, code);
          segments = classificationContext.segments;
        } else {
          segments = classifyModule(parsed, code);
        }
      } catch (err) {
        console.warn(`[phantom] Skipping ${id}:`, err instanceof Error ? err.message : err);
        return null;
      }

      // SSR boundary analysis (runs alongside existing classification)
      if (options.ssrBoundaries && classificationContext) {
        try {
          const ssrResult = classifyModuleSSR(parsed, code, classificationContext);
          if (ssrResult.components.length > 0 || ssrResult.hasTopLevelBrowserAccess) {
            ssrBoundaryResults.set(id, ssrResult);
          }
        } catch (ssrErr) {
          if (!options.silent) {
            console.warn(
              `[phantom] SSR boundary analysis failed for ${id}:`,
              ssrErr instanceof Error ? ssrErr.message : ssrErr,
            );
          }
        }
      }

      // Build component profile for downstream modules
      const profile = buildComponentProfile(segments);
      if (profile) {
        componentProfiles.set(id, profile);
      }

      // Record re-export mappings for barrel file resolution
      if (parsed.reExports.length > 0) {
        const mappings = new Map<string, { source: string; importedName: string }>();
        for (const re of parsed.reExports) {
          mappings.set(re.exportedName, { source: re.source, importedName: re.importedName });
        }
        reExportMap.set(id, mappings);
      }

      // ── Phase 2: Lazy candidate detection ───────────────────────────
      let lazyCandidates: LazyCandidate[] | undefined;
      let lazyKeptStatic: Array<{ localName: string; source: string; reason: string }> | undefined;

      const enableLazy = options.enableLazy !== false;
      if (enableLazy) {
        const lazyResult = detectLazyCandidates(parsed, code, segments, componentProfiles, reExportMap);
        if (lazyResult.lazy.length > 0) {
          lazyCandidates = lazyResult.lazy;
        }
        if (lazyResult.keepStatic.length > 0) {
          lazyKeptStatic = lazyResult.keepStatic;
        }
      }

      // Apply cached LLM decisions if available (avoids LLM call entirely)
      let usedCache = false;
      if (lazyCandidates && lazyCandidates.length > 0 && refinementCache) {
        const codeHash = hashCode(code);
        const cached = refinementCache.entries[id];
        if (cached && cached.codeHash === codeHash) {
          applyCachedDecisions(lazyCandidates, cached);
          usedCache = true;
        }
      }

      // ── Phase 3: Extraction (handler chunks + lazy transforms) ──────
      const confidenceThreshold = options.confidenceThreshold ?? 0.8;
      const heuristicExtracted = extractModule(
        parsed, segments, code, confidenceThreshold, id, lazyCandidates,
      );

      if (!heuristicExtracted) {
        // Even without extractions, annotate mode may need to prepend "use client"
        if (options.ssrBoundaries === 'annotate') {
          const ssrResult = ssrBoundaryResults.get(id);
          if (ssrResult && shouldAnnotateClientOnly(ssrResult) && !hasUseClientDirective(code)) {
            return { code: `"use client";\n${code}`, map: null };
          }
        }
        return null;
      }

      const heuristicResult: AnalysisResult = {
        path: id,
        segments,
        hasExtractions: true,
        clientCode: heuristicExtracted.clientCode,
        clientMap: heuristicExtracted.clientMap,
        chunkModules: heuristicExtracted.chunkModules,
        lazyCandidates,
        lazyKeptStatic,
      };

      // ── Phase 4: LLM refinement (async, batched) ───────────────────
      // If we have lazy candidates, an API key, and no cache hit,
      // enqueue for batched LLM refinement. The transform awaits the
      // shared batch Promise and returns LLM-refined code.
      const needsLLM = lazyCandidates &&
                        lazyCandidates.length > 0 &&
                        options.cerebrasApiKey &&
                        !usedCache;

      let finalResult: AnalysisResult;
      if (needsLLM) {
        finalResult = await enqueueLLMBatch({
          id,
          code,
          parsed,
          segments,
          lazyCandidates: lazyCandidates!,
          lazyKeptStatic: lazyKeptStatic ?? [],
          heuristicResult,
        });
      } else {
        finalResult = heuristicResult;
      }

      // ── Phase 5: Register results ──────────────────────────────────
      modulesWithExtractions++;

      const newVirtualIds: string[] = [];
      for (const chunkMod of finalResult.chunkModules ?? []) {
        const virtualId = `${VIRTUAL_PREFIX}${chunkMod.id}.chunk.js`;
        chunkModuleMap.set(virtualId, { code: chunkMod.code, map: chunkMod.map });
        newVirtualIds.push(virtualId);

        const segment = finalResult.segments.find((s) => s.id === chunkMod.id);
        manifestEntries.push({
          segmentId: chunkMod.id,
          sourceFile: id,
          virtualId,
          name: segment?.name ?? chunkMod.id,
          kind: 'handler',
        });
      }

      if (finalResult.lazyCandidates) {
        for (const lc of finalResult.lazyCandidates) {
          manifestEntries.push({
            segmentId: `lazy_${lc.localName}`,
            sourceFile: id,
            virtualId: lc.source,
            name: `lazy(${lc.localName})`,
            kind: 'lazy',
          });
        }
      }

      sourceToChunks.set(id, newVirtualIds);

      let outputCode = finalResult.clientCode!;

      // Annotate mode: prepend "use client" to ClientOnly modules
      if (options.ssrBoundaries === 'annotate') {
        const ssrResult = ssrBoundaryResults.get(id);
        if (ssrResult && shouldAnnotateClientOnly(ssrResult) && !hasUseClientDirective(outputCode)) {
          outputCode = `"use client";\n${outputCode}`;
        }
      }

      return {
        code: outputCode,
        map: finalResult.clientMap ?? null,
      };
    },

    resolveId(id: string) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        return id;
      }
      if (id.startsWith(PUBLIC_PREFIX)) {
        return `\0${id}`;
      }
      return null;
    },

    load(id: string) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        const entry = chunkModuleMap.get(id);
        if (entry) return { code: entry.code, map: entry.map };
      }
      if (id.startsWith(PUBLIC_PREFIX)) {
        const virtualId = `${VIRTUAL_PREFIX}${id.slice(PUBLIC_PREFIX.length)}`;
        const entry = chunkModuleMap.get(virtualId);
        if (entry) return { code: entry.code, map: entry.map };
      }
      return undefined;
    },

    // Register phantom: URI scheme for Webpack compatibility
    webpack(compiler: any) {
      compiler.hooks.compilation.tap('phantom', (compilation: any) => {
        const NormalModule = compiler.webpack?.NormalModule;
        if (!NormalModule) return;
        NormalModule.getCompilationHooks(compilation).readResource
          .for('phantom')
          .tapAsync('phantom', (_loaderContext: any, callback: any) => {
            callback(null, '');
          });
      });
    },

    buildEnd() {
      // SSR mode: skip manifest writing and print a brief notice
      if (options.ssr) {
        if (!options.silent) {
          console.log('[phantom] SSR mode \u2014 all transforms skipped');
        }
        return;
      }

      // Write manifest
      const manifest: PhantomManifest = {
        version: 1,
        entries: manifestEntries,
        stats: {
          totalModulesProcessed: moduleCount,
          totalSegmentsExtracted: manifestEntries.length,
        },
      };

      // Add SSR boundary data to manifest
      if (options.ssrBoundaries && ssrBoundaryResults.size > 0) {
        manifest.ssrBoundaries = [...ssrBoundaryResults.entries()].map(
          ([file, result]) => ({ sourceFile: file, components: result.components }),
        );
      }

      const manifestPath = options.manifestPath ?? 'phantom.manifest.json';
      try {
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      } catch (err) {
        console.error(`[phantom] Failed to write manifest to "${manifestPath}":`, err);
      }

      if (!options.silent) {
        printBuildSummary(moduleCount, modulesWithExtractions, manifestEntries, manifestPath);

        // Print SSR boundary summary
        if (options.ssrBoundaries && ssrBoundaryResults.size > 0) {
          printSSRBoundarySummary(ssrBoundaryResults, options.ssrBoundaries);
        }
      }
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Check if the LLM made any changes compared to heuristic decisions.
 */
function hasLLMChanges(
  original: LazyCandidate[],
  refined: LazyCandidate[],
  movedToStatic: Array<{ localName: string; source: string; reason: string }>,
): boolean {
  if (movedToStatic.length > 0) return true;
  if (original.length !== refined.length) return true;

  for (const orig of original) {
    const ref = refined.find((r) => r.localName === orig.localName);
    if (!ref) return true;
    if (orig.prefetch !== ref.prefetch) return true;
    if (orig.suspenseGroup !== ref.suspenseGroup) return true;
  }

  return false;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

/**
 * Apply cached LLM decisions to heuristic lazy candidates.
 */
function applyCachedDecisions(
  candidates: LazyCandidate[],
  cached: LazyCacheEntry,
): void {
  const decisionMap = new Map(
    cached.decisions.map((d) => [d.localName, d]),
  );

  for (const candidate of candidates) {
    const decision = decisionMap.get(candidate.localName);
    if (decision) {
      candidate.prefetch = decision.prefetch;
      candidate.suspenseGroup = decision.suspenseGroup;
      candidate.reason = `cached LLM: ${decision.reason}`;
    }
  }
}

function inferComponentName(filePath: string): string {
  const base = basename(filePath);
  const dotIdx = base.indexOf('.');
  return dotIdx > 0 ? base.slice(0, dotIdx) : base;
}

// ── Build summary ──────────────────────────────────────────────────────

function printBuildSummary(
  totalModules: number,
  extractedModules: number,
  entries: ManifestEntry[],
  manifestPath: string,
): void {
  if (entries.length === 0) {
    console.log(`[phantom] Build complete — ${totalModules} modules scanned, no handlers extracted`);
    return;
  }

  const handlerEntries = entries.filter((e) => e.kind === 'handler');
  const lazyEntries = entries.filter((e) => e.kind === 'lazy');

  const lines: string[] = [];
  lines.push(`[phantom] Build complete`);
  lines.push(`  Modules scanned: ${totalModules}`);
  lines.push(`  Modules with extractions: ${extractedModules}`);
  lines.push(`  Handlers extracted: ${handlerEntries.length}`);
  if (lazyEntries.length > 0) {
    lines.push(`  Lazy components: ${lazyEntries.length}`);
  }

  const bySource = new Map<string, string[]>();
  for (const entry of entries) {
    let names = bySource.get(entry.sourceFile);
    if (!names) {
      names = [];
      bySource.set(entry.sourceFile, names);
    }
    names.push(entry.name);
  }

  for (const [sourceFile, names] of bySource) {
    lines.push(`    ${sourceFile} → ${names.join(', ')}`);
  }

  lines.push(`  Manifest: ${manifestPath}`);

  console.log(lines.join('\n'));
}

// ── Component profiling ───────────────────────────────────────────────

function buildComponentProfile(segments: ClassifiedSegment[]): ComponentProfile | null {
  if (!segments || segments.length === 0) return null;

  const handlerSegments = segments.filter(
    (s) => s.classification === 'EventHandler',
  );
  const hasEffects = segments.some((s) =>
    s.reasons.some((r) => r.includes('useEffect') || r.includes('useLayoutEffect')),
  );
  const hasState = segments.some((s) =>
    s.dependencies.some((d) => d.startsWith('set') || d === 'dispatch'),
  );

  return {
    hasHandlers: handlerSegments.length > 0,
    hasState,
    hasEffects,
    handlerCount: handlerSegments.length,
    providesContext: false,
    estimatedSize: 0,
  };
}

// ── SSR Boundary Helpers ──────────────────────────────────────────────

/**
 * Check if a module should get a "use client" annotation.
 * True if all components are ClientOnly or the module has top-level browser access.
 */
function shouldAnnotateClientOnly(ssrResult: SSRModuleResult): boolean {
  if (ssrResult.hasTopLevelBrowserAccess) return true;
  if (ssrResult.components.length === 0) return false;
  return ssrResult.components.every((c) => c.classification === 'ClientOnly');
}

/**
 * Check if code already has a "use client" directive at the top.
 */
function hasUseClientDirective(code: string): boolean {
  // Match "use client" or 'use client' at the start of the file (after optional whitespace)
  return /^\s*["']use client["'];?/m.test(code);
}

function printSSRBoundarySummary(
  results: Map<string, SSRModuleResult>,
  mode: 'auto' | 'annotate',
): void {
  let fullyStatic = 0;
  let ssrSafe = 0;
  let clientOnly = 0;

  for (const [, result] of results) {
    for (const comp of result.components) {
      if (comp.classification === 'FullyStatic') fullyStatic++;
      else if (comp.classification === 'SSRSafe') ssrSafe++;
      else if (comp.classification === 'ClientOnly') clientOnly++;
    }
  }

  const total = fullyStatic + ssrSafe + clientOnly;
  if (total === 0) return;

  const lines: string[] = [];
  lines.push(`[phantom] SSR boundary analysis (${mode} mode)`);
  lines.push(`  Components analyzed: ${total}`);
  lines.push(`  FullyStatic: ${fullyStatic} (zero client JS needed)`);
  lines.push(`  SSRSafe: ${ssrSafe} (can SSR, needs hydration)`);
  lines.push(`  ClientOnly: ${clientOnly} (needs "use client" boundary)`);

  console.log(lines.join('\n'));
}
