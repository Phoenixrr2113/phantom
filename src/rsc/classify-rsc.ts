import { parseModule } from '../analyzer.js';
import { classifyModuleWithContext, classifyModuleSSR } from '../classify/index.js';
import type { SSRComponentResult } from '../types.js';
import type { RscFileResult, RscComponentResult, RscVerdict } from './types.js';

/**
 * Derive an RSC-centric reason for a must-be-client component. phantom's SSR
 * reasons are phrased around first-paint SSR safety (e.g. "Render path is free
 * of browser APIs"), which is misleading for RSC — so surface the concrete
 * client-only feature (hook / browser API / handler) instead.
 */
function clientReason(c: SSRComponentResult): string {
  if (c.hooks.length > 0) return `uses ${c.hooks.join(', ')}`;
  if (c.renderPathBrowserAPIs.length > 0) return `uses browser API: ${c.renderPathBrowserAPIs.join(', ')}`;
  const handlerReason = c.reasons.find((r) => /handler/i.test(r));
  return handlerReason ?? c.reasons[0] ?? `${c.classification} (client-only features)`;
}

/**
 * Classify a single file for React Server Components readiness.
 * `'use client'` is a file-level directive, so the file verdict is a rollup of
 * its components: a file is must-be-client if ANY component is; mixed if it has
 * both server-eligible and must-be-client components (a split candidate);
 * non-component if no React components were detected.
 *
 * `imports` is left empty here and populated later by the graph resolver.
 */
export function classifyFileRsc(code: string, file: string): RscFileResult {
  const analyzed = parseModule(code, file);
  const ctx = classifyModuleWithContext(analyzed, code);
  const ssr = classifyModuleSSR(analyzed, code, ctx);

  const sizeByName = new Map<string, number>();
  for (const fn of analyzed.functions) {
    if (!fn.name || !fn.span) continue;
    const sz = (fn.span.end ?? 0) - (fn.span.start ?? 0);
    if (sz > (sizeByName.get(fn.name) ?? 0)) sizeByName.set(fn.name, sz);
  }

  const components: RscComponentResult[] = ssr.components.map((c) => {
    const serverEligible = c.classification === 'FullyStatic' && !ssr.hasTopLevelBrowserAccess;
    const verdict: RscVerdict = serverEligible ? 'server-eligible' : 'must-be-client';
    const reason = serverEligible
      ? 'pure props→JSX (no hooks/handlers/browser)'
      : clientReason(c);
    return { name: c.name, verdict, reason, sizeBytes: sizeByName.get(c.name) ?? 0 };
  });

  const hasComponents = components.length > 0;
  let fileVerdict: RscFileResult['fileVerdict'];
  if (!hasComponents) {
    fileVerdict = 'non-component';
  } else {
    const anyClient = components.some((c) => c.verdict === 'must-be-client') || ssr.hasTopLevelBrowserAccess;
    const anyServer = components.some((c) => c.verdict === 'server-eligible');
    fileVerdict = anyClient && anyServer ? 'mixed' : anyClient ? 'must-be-client' : 'server-eligible';
  }

  return { file, hasComponents, fileVerdict, components, imports: [], sizeBytes: code.length };
}
