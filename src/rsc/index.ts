/**
 * RSC readiness orchestrator. Wires the five analysis units — graph resolver,
 * contagion engine, frontier computation, rescue detection, and serialization
 * hazard detection — into a single whole-codebase {@link RscReport}.
 *
 * Report-only and read-only: it never writes or transforms source. The report
 * is the product; emitters live in ./report.ts and are re-exported here.
 */

import { readFileSync } from 'node:fs';
import { parseModule } from '../analyzer.js';
import { buildComponentGraph } from './resolve-graph.js';
import { computeContagion, computeFrontier } from './contagion.js';
import { findRescues, findHazardsInModule } from './rescue-hazards.js';
import type { RscReport } from './types.js';

/**
 * Run the whole-codebase RSC readiness analysis over `dir`: build the resolved
 * component graph, propagate client contagion, compute the minimal 'use client'
 * frontier, and detect children-rescue candidates + serialization hazards.
 * Report-only and read-only. Hazards are detected only on server-eligible files
 * (genuine would-be-server parents passing props across the boundary).
 */
export function analyzeRscReadiness(dir: string): RscReport {
  const graph = buildComponentGraph(dir);
  const contagion = computeContagion(graph);
  const frontier = computeFrontier(graph, contagion.clientClosure);
  const rescues = findRescues(graph, contagion);

  const files = [...graph.files.values()];
  const componentFiles = files.filter((f) => f.hasComponents).length;
  const serverEligibleUpperBound = files.filter((f) => f.fileVerdict === 'server-eligible').length;
  const totalComponentBytes = files.filter((f) => f.hasComponents).reduce((s, f) => s + f.sizeBytes, 0);
  const realizableServerPctBytes =
    totalComponentBytes === 0 ? 0 : (contagion.realizableServerBytes / totalComponentBytes) * 100;

  // Hazards: only on server-eligible files (would-be server parents). A 'mixed'
  // file is itself a client file, so its props are client→client, not a boundary crossing.
  // Re-parsing server-eligible files here for hazard JSX-walking is an accepted v1
  // tradeoff — it's a bounded subset and keeps the units cleanly separated.
  const hazards: RscReport['hazards'] = [];
  for (const [file, result] of graph.files) {
    if (result.fileVerdict !== 'server-eligible') continue;
    const imported = result.importedComponents;
    if (!imported || imported.size === 0) continue;
    const isClientComponent = (tag: string): boolean => {
      const target = imported.get(tag);
      if (!target) return false;
      const v = graph.files.get(target)?.fileVerdict;
      return v === 'must-be-client' || v === 'mixed';
    };
    let code: string;
    let analyzed: ReturnType<typeof parseModule>;
    try {
      code = readFileSync(file, 'utf-8');
      analyzed = parseModule(code, file);
    } catch {
      continue; // unreadable/unparseable — skip hazards for this file
    }
    for (const h of findHazardsInModule(analyzed, code, file, isClientComponent)) {
      hazards.push({ file: h.file, prop: h.prop, kind: h.kind });
    }
  }

  return {
    componentFiles,
    edgeResolutionPct: graph.edgeResolution * 100,
    serverEligibleUpperBound,
    realizableServerFiles: contagion.realizableServer.size,
    realizableServerBytes: contagion.realizableServerBytes,
    realizableServerPctBytes,
    clientFrontier: [...frontier].sort(),
    rescues,
    hazards,
  };
}

export { toJSON, toMarkdown, toTerminal } from './report.js';
