import { basename } from 'node:path';
import type { ComponentGraph } from './types.js';
import type { ContagionResult } from './contagion.js';

export interface RescueCandidate {
  file: string;       // the server-eligible file that could be rescued
  trappedBy: string;  // the single client file that drags it into the closure
  hint: string;       // human-readable children-slot suggestion
}

/** Best display name for a file: its first component name, else basename without extension. */
function displayName(graph: ComponentGraph, file: string): string {
  const name = graph.files.get(file)?.components[0]?.name;
  if (name) return name;
  return basename(file).replace(/\.(tsx|ts|jsx|js)$/, '');
}

/**
 * Find children-slot rescue candidates: server-eligible files pulled into the
 * client closure ONLY by a single direct import from exactly one client file.
 * Such a file can often be refactored to be passed as `children` to that client
 * component, keeping it on the server. Shallow v1: multi-importer or
 * deeper-path contamination is intentionally not flagged.
 */
export function findRescues(graph: ComponentGraph, contagion: ContagionResult): RescueCandidate[] {
  const { clientClosure } = contagion;

  // Map each imported file → the client files that import it directly.
  const clientImporters = new Map<string, string[]>();
  for (const file of clientClosure) {
    const node = graph.files.get(file);
    if (!node) continue;
    for (const imported of node.imports) {
      const list = clientImporters.get(imported);
      if (list) list.push(file);
      else clientImporters.set(imported, [file]);
    }
  }

  const rescues: RescueCandidate[] = [];
  for (const [file, result] of graph.files) {
    if (result.fileVerdict !== 'server-eligible') continue; // only server-eligible can be rescued
    if (!clientClosure.has(file)) continue;                 // must actually be trapped
    const importers = clientImporters.get(file);
    if (!importers || importers.length !== 1) continue;     // exactly one direct client importer (v1)
    const trappedBy = importers[0];
    rescues.push({
      file,
      trappedBy,
      hint: `${displayName(graph, file)} is server-eligible but pulled to the client by <${displayName(graph, trappedBy)}>; pass it as children to keep it on the server.`,
    });
  }
  return rescues;
}
