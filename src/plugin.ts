import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Validate PhantomPluginOptions and throw a descriptive error for invalid values.
 * Called once at plugin initialisation so mistakes surface immediately at build startup.
 */
function validateOptions(options: PhantomPluginOptions): void {
  if (options.confidenceThreshold !== undefined) {
    const ct = options.confidenceThreshold;
    if (typeof ct !== 'number' || Number.isNaN(ct) || ct < 0 || ct > 1) {
      throw new Error(
        `[phantom] Invalid option "confidenceThreshold": expected a number between 0 and 1, got ${JSON.stringify(ct)}. ` +
        `Hint: use a value like 0.8 (80% confidence required to extract a handler).`,
      );
    }
  }

  if (options.minHandlerSize !== undefined) {
    const mhs = options.minHandlerSize;
    if (typeof mhs !== 'number' || Number.isNaN(mhs) || mhs < 0 || !Number.isFinite(mhs)) {
      throw new Error(
        `[phantom] Invalid option "minHandlerSize": expected a non-negative number (bytes), got ${JSON.stringify(mhs)}. ` +
        `Hint: use 0 to extract all handlers, or 200 (the default) to skip tiny handlers where the stub adds more bytes than it saves.`,
      );
    }
  }

  if (options.preloadStrategy !== undefined) {
    const ps = options.preloadStrategy;
    if (ps !== 'idle' && ps !== 'none') {
      throw new Error(
        `[phantom] Invalid option "preloadStrategy": expected "idle" or "none", got ${JSON.stringify(ps)}. ` +
        `Hint: use "idle" to inject requestIdleCallback modulepreload hints, or "none" (the default) to load chunks on-demand.`,
      );
    }
  }
}

export const phantom = createUnplugin((options: PhantomPluginOptions = {}) => {
  validateOptions(options);

  // ── Shared state accumulated across transform calls ──────────────────
  const chunkModuleMap = new Map<string, { code: string; map: SourceMapLike }>();
  const manifestEntries: ManifestEntry[] = [];
  /** Reverse map: source file → virtual IDs it produced (for HMR cleanup) */
  const sourceToChunks = new Map<string, string[]>();
  /** Reverse map: virtual chunk ID → source file that produced it (for alias resolution) */
  const chunkToSource = new Map<string, string>();
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
  /** Grouped module virtual IDs (for idle modulepreload injection) */
  const groupedModuleIds = new Set<string>();
  /** Map from grouped virtual ID → emitted filename (populated in generateBundle) */
  const emittedGroupChunks = new Map<string, string>();
  /** Vite resolved base path */
  let resolvedBase = '/';
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
        options.minHandlerSize ?? 200,
      );

      if (extracted) {
        mod.resolve({
          path: mod.id,
          segments: mod.segments,
          hasExtractions: true,
          clientCode: extracted.clientCode,
          clientMap: extracted.clientMap,
          chunkModules: extracted.chunkModules,
          extractedSegmentIds: extracted.extractedSegmentIds,
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
      chunkToSource.clear();
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
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[phantom] TRANSFORM_SKIP: Could not analyse ${id} — no Phantom transforms will be applied to this file.\n` +
          `  Reason: ${msg}\n` +
          `  Hint: If this file should be ignored intentionally, add it to the "exclude" option. ` +
          `Set "silent: true" to suppress this warning.`,
        );
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
            const ssrMsg = ssrErr instanceof Error ? ssrErr.message : String(ssrErr);
            console.warn(
              `[phantom] SSR_ANALYSIS_ERROR: SSR boundary detection failed for ${id} — ` +
              `the file will be treated as having no SSR boundaries.\n` +
              `  Reason: ${ssrMsg}\n` +
              `  Hint: If this recurs, set "ssrBoundaries: false" to disable SSR analysis entirely, ` +
              `or "silent: true" to suppress this warning.`,
            );
          }
        }
      }

      // Build component profile for downstream modules
      const profile = buildComponentProfile(segments, code.length);
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
        // Pre-populate profiles for imports not yet processed.
        // In production builds, Rollup transforms parents before children,
        // so child profiles aren't available yet. Use source file size as a
        // conservative size estimate for the JS cost threshold check.
        const moduleDir = dirname(id);
        const PROFILE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js', ''];
        for (const imp of parsed.imports) {
          if (!imp.source.startsWith('./') && !imp.source.startsWith('../')) continue;
          for (const ext of PROFILE_EXTS) {
            const candidate = pathResolve(moduleDir, imp.source + ext);
            if (componentProfiles.has(candidate)) break;
            try {
              const st = statSync(candidate);
              if (st.isFile()) {
                componentProfiles.set(candidate, {
                  hasHandlers: false,
                  hasState: false,
                  hasEffects: false,
                  handlerCount: 0,
                  providesContext: false,
                  estimatedSize: st.size,
                });
                break;
              }
            } catch { /* try next extension */ }
          }
        }

        const lazyResult = detectLazyCandidates(parsed, code, segments, componentProfiles, reExportMap);
        if (lazyResult.lazy.length > 0) {
          lazyCandidates = lazyResult.lazy;
        }
        if (lazyResult.keepStatic.length > 0) {
          lazyKeptStatic = lazyResult.keepStatic;
        }
      }

      // Warn about common mistakes that may cause unexpected behavior
      if (!options.silent) {
        warnCommonMistakes(code, id, segments, lazyCandidates, lazyKeptStatic, options.minHandlerSize ?? 200);
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
      const minHandlerSize = options.minHandlerSize ?? 200;
      const heuristicExtracted = extractModule(
        parsed, segments, code, confidenceThreshold, id, lazyCandidates, minHandlerSize,
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
        extractedSegmentIds: heuristicExtracted.extractedSegmentIds,
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
        // Grouped modules use `grp_xxx.js`, individual use `seg_xxx.chunk.js`
        const isGrouped = chunkMod.id.startsWith('grp_');
        const virtualId = isGrouped
          ? `${VIRTUAL_PREFIX}${chunkMod.id}.js`
          : `${VIRTUAL_PREFIX}${chunkMod.id}.chunk.js`;
        chunkModuleMap.set(virtualId, { code: chunkMod.code, map: chunkMod.map });
        chunkToSource.set(virtualId, id);
        newVirtualIds.push(virtualId);

        if (isGrouped) {
          // Track grouped module IDs for idle modulepreload
          groupedModuleIds.add(virtualId);
        }
      }

      // Create manifest entries per individual segment ID
      if (finalResult.extractedSegmentIds && finalResult.extractedSegmentIds.length > 0) {
        const groupVirtualId = newVirtualIds[0]; // The grouped module
        for (const segId of finalResult.extractedSegmentIds) {
          const segment = finalResult.segments.find((s) => s.id === segId);
          manifestEntries.push({
            segmentId: segId,
            sourceFile: id,
            virtualId: groupVirtualId,
            name: segment?.name ?? segId,
            kind: 'handler',
          });
        }
      } else {
        // Fallback for non-grouped (shouldn't happen but safe)
        for (const chunkMod of finalResult.chunkModules ?? []) {
          const segment = finalResult.segments.find((s) => s.id === chunkMod.id);
          const virtualId = `${VIRTUAL_PREFIX}${chunkMod.id}.chunk.js`;
          manifestEntries.push({
            segmentId: chunkMod.id,
            sourceFile: id,
            virtualId,
            name: segment?.name ?? chunkMod.id,
            kind: 'handler',
          });
        }
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

    async resolveId(id: string, importer?: string) {
      // Resolve phantom-build/runtime to the actual runtime file
      // (needed when phantom-build is not installed as a dependency in the target project)
      if (id === 'phantom-build/runtime') {
        const thisDir = dirname(fileURLToPath(import.meta.url));
        return pathResolve(thisDir, 'runtime', 'index.js');
      }
      if (id.startsWith(VIRTUAL_PREFIX)) {
        return id;
      }
      if (id.startsWith(PUBLIC_PREFIX)) {
        return `\0${id}`;
      }
      // When a chunk virtual module imports a non-relative, non-bare-package specifier
      // (e.g. tsconfig path aliases like @/utils), delegate resolution to the bundler
      // using the original source file as the importer context.
      if (importer && importer.startsWith(VIRTUAL_PREFIX)) {
        const originalSource = chunkToSource.get(importer);
        if (originalSource) {
          // unplugin doesn't expose this.resolve() in its types, but Vite/Rollup
          // provide it at runtime on the plugin context
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = this as any;
          if (typeof ctx.resolve === 'function') {
            const resolved = await ctx.resolve(id, originalSource, { skipSelf: true });
            if (resolved) return resolved;
          }
        }
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

    // Vite-specific hooks for idle modulepreload injection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vite: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configResolved(config: any) {
        resolvedBase = config.base || '/';
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateBundle(_: any, bundle: Record<string, any>) {
        if (options.ssr) return;
        // Map grouped virtual IDs to their emitted filenames
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk') continue;
          // Vite/Rollup exposes moduleIds on chunk assets
          const moduleIds: string[] = chunk.moduleIds ?? Object.keys(chunk.modules ?? {});
          for (const moduleId of moduleIds) {
            if (groupedModuleIds.has(moduleId)) {
              emittedGroupChunks.set(moduleId, fileName);
            }
          }
        }
      },
      transformIndexHtml(html: string) {
        if (options.ssr || options.preloadStrategy !== 'idle' || emittedGroupChunks.size === 0) return html;
        // Build idle preload script
        const base = resolvedBase.endsWith('/') ? resolvedBase : resolvedBase + '/';
        const chunkPaths = [...emittedGroupChunks.values()].map(
          (fileName) => `"${base}${fileName}"`,
        );
        const script = [
          '<script>',
          '// Phantom: preload handler chunks during idle time',
          `"requestIdleCallback"in window?requestIdleCallback(function(){[${chunkPaths.join(',')}].forEach(function(h){var l=document.createElement("link");l.rel="modulepreload";l.href=h;document.head.appendChild(l)})}):void 0`,
          '</script>',
        ].join('\n');
        return html.replace('</body>', `${script}\n</body>`);
      },
    } as Record<string, unknown>,

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

// ── Common mistake warnings ───────────────────────────────────────────

/**
 * Warn about common handler/lazy patterns that may cause unexpected behaviour.
 * Called once per transformed module, after classification and lazy detection.
 */
function warnCommonMistakes(
  code: string,
  id: string,
  segments: ClassifiedSegment[],
  lazyCandidates: LazyCandidate[] | undefined,
  lazyKeptStatic: Array<{ localName: string; source: string; reason: string }> | undefined,
  minHandlerSize: number,
): void {
  const handlerSegments = segments.filter((s) => s.classification === 'EventHandler');

  // 1. Handlers that reference `this` — will break when extracted out of class context
  for (const seg of handlerSegments) {
    const handlerCode = code.slice(seg.span.start, seg.span.end);
    if (/\bthis\b/.test(handlerCode)) {
      console.warn(
        `[phantom] THIS_IN_HANDLER: Handler "${seg.name}" in ${id} references "this".\n` +
        `  Extracted handlers run outside their original class context — "this" will be undefined at runtime.\n` +
        `  Fix: Use arrow function class fields (handleClick = () => {...}) or bind in the constructor.`,
      );
    }
  }

  // 2. Context providers that were kept static (informational — explains why they weren't lazified)
  if (lazyKeptStatic) {
    for (const kept of lazyKeptStatic) {
      if (kept.reason.includes('Context provider')) {
        console.warn(
          `[phantom] CONTEXT_PROVIDER_STATIC: "${kept.localName}" (from "${kept.source}") in ${id} was kept static because it is a context provider.\n` +
          `  Context providers must be mounted before consumers render — lazy loading would leave consumers with the default context value until the chunk loads.\n` +
          `  Tip: This is correct behaviour. To code-split, extract non-provider logic into a separate lazily-imported component.`,
        );
      }
    }
  }

  // 3. Event handlers too small to be worth extracting (stub overhead exceeds savings)
  const smallHandlers = handlerSegments.filter((s) => {
    const size = s.span.end - s.span.start;
    return size > 0 && size < minHandlerSize;
  });
  if (smallHandlers.length > 0) {
    const summary = smallHandlers
      .map((s) => `${s.name} (${s.span.end - s.span.start}b)`)
      .join(', ');
    console.warn(
      `[phantom] SMALL_HANDLERS: ${smallHandlers.length} handler(s) in ${id} are below the minHandlerSize threshold (${minHandlerSize}b) and will not be extracted: ${summary}.\n` +
      `  Hint: Small handlers produce stubs larger than the handler itself. Lower minHandlerSize to force extraction, or add more logic to justify it.`,
    );
  }
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

function buildComponentProfile(segments: ClassifiedSegment[], sourceBytes: number): ComponentProfile | null {
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
    estimatedSize: sourceBytes,
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
