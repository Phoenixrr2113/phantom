import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createUnplugin } from 'unplugin';
import type { ManifestEntry, PhantomManifest, PhantomPluginOptions, SourceMapLike } from './types.js';
import { analyzeModule } from './analyzer.js';

/** Prefix for Phantom virtual chunk modules */
export const VIRTUAL_PREFIX = '\0phantom:';

/** Public prefix used in import statements (before resolution) */
export const PUBLIC_PREFIX = 'phantom:';

export const phantom = createUnplugin((options: PhantomPluginOptions = {}) => {
  // ── Shared state accumulated across transform calls ──────────────────
  const chunkModuleMap = new Map<string, { code: string; map: SourceMapLike }>();
  const manifestEntries: ManifestEntry[] = [];
  /** Reverse map: source file → virtual IDs it produced (for HMR cleanup) */
  const sourceToChunks = new Map<string, string[]>();
  let moduleCount = 0;
  let modulesWithExtractions = 0;

  return {
    name: 'phantom',
    enforce: 'pre' as const,

    // Reset state on each build cycle (critical for watch/HMR mode)
    buildStart() {
      chunkModuleMap.clear();
      manifestEntries.length = 0;
      sourceToChunks.clear();
      moduleCount = 0;
      modulesWithExtractions = 0;
    },

    transformInclude(id: string) {
      return /\.[jt]sx?$/.test(id) && !id.includes('node_modules');
    },

    transform(code: string, id: string) {
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

      let result;
      try {
        result = analyzeModule(code, id, options);
      } catch (err) {
        // Parse errors or analysis failures should not crash the build.
        // Log and skip — the file passes through unmodified.
        console.warn(`[phantom] Skipping ${id}:`, err instanceof Error ? err.message : err);
        return null;
      }

      if (!result.hasExtractions || !result.clientCode || !result.chunkModules) {
        return null;
      }

      modulesWithExtractions++;

      // Register each chunk module as a virtual module
      const newVirtualIds: string[] = [];
      for (const chunkMod of result.chunkModules) {
        const virtualId = `${VIRTUAL_PREFIX}${chunkMod.id}.chunk.js`;
        chunkModuleMap.set(virtualId, { code: chunkMod.code, map: chunkMod.map });
        newVirtualIds.push(virtualId);

        // Find the segment name from classified segments
        const segment = result.segments.find((s) => s.id === chunkMod.id);

        manifestEntries.push({
          segmentId: chunkMod.id,
          sourceFile: id,
          virtualId,
          name: segment?.name ?? chunkMod.id,
        });
      }

      // Track which chunks this source file produced (for HMR cleanup)
      sourceToChunks.set(id, newVirtualIds);

      return { code: result.clientCode, map: result.clientMap ?? null };
    },

    resolveId(id: string) {
      // Already resolved (has \0 prefix)
      if (id.startsWith(VIRTUAL_PREFIX)) {
        return id;
      }
      // Public prefix — add \0 to mark as virtual
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
      // Webpack may pass the public prefix (without \0) after scheme resolution
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
            // Return empty — the load hook provides actual content
            callback(null, '');
          });
      });
    },

    buildEnd() {
      const manifest: PhantomManifest = {
        version: 1,
        entries: manifestEntries,
        stats: {
          totalModulesProcessed: moduleCount,
          totalSegmentsExtracted: manifestEntries.length,
        },
      };

      const manifestPath = options.manifestPath ?? 'phantom.manifest.json';
      try {
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      } catch (err) {
        console.error(`[phantom] Failed to write manifest to "${manifestPath}":`, err);
      }

      // Print build summary unless suppressed
      if (!options.silent) {
        printBuildSummary(moduleCount, modulesWithExtractions, manifestEntries, manifestPath);
      }
    },
  };
});

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

  const lines: string[] = [];
  lines.push(`[phantom] Build complete`);
  lines.push(`  Modules scanned: ${totalModules}`);
  lines.push(`  Handlers extracted: ${entries.length} from ${extractedModules} module${extractedModules === 1 ? '' : 's'}`);

  // Group by source file
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
