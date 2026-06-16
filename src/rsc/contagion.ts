import type { ComponentGraph } from './types.js';

/** Result of client-contagion analysis over a component graph. */
export interface ContagionResult {
  /** Files that must be client: seeds (must-be-client / mixed) ∪ everything reachable from them via import edges. */
  clientClosure: Set<string>;
  /** Server-eligible files NOT trapped in the client closure — the realizable-server set. */
  realizableServer: Set<string>;
  /** Sum of `sizeBytes` over the realizable-server set. */
  realizableServerBytes: number;
}

/**
 * Propagate client-ness forward along import edges and compute the
 * realizable-server set. Seeds = files whose verdict is `must-be-client` or
 * `mixed` (a mixed file must become a client file, all-or-nothing). BFS follows
 * each node's resolved `imports`; the transitive closure is the client set.
 * Realizable-server = `server-eligible` files outside that closure.
 */
export function computeContagion(graph: ComponentGraph): ContagionResult {
  const clientClosure = new Set<string>();
  const queue: string[] = [];

  // Seed from intrinsically-client files.
  for (const [file, result] of graph.files) {
    if (result.fileVerdict === 'must-be-client' || result.fileVerdict === 'mixed') {
      if (!clientClosure.has(file)) {
        clientClosure.add(file);
        queue.push(file);
      }
    }
  }

  // BFS forward over import edges: a client file's imports are client.
  while (queue.length > 0) {
    const file = queue.shift()!;
    const node = graph.files.get(file);
    if (!node) continue;
    for (const imported of node.imports) {
      if (!clientClosure.has(imported)) {
        clientClosure.add(imported);
        queue.push(imported);
      }
    }
  }

  // Realizable-server = server-eligible files the blast radius didn't reach.
  const realizableServer = new Set<string>();
  let realizableServerBytes = 0;
  for (const [file, result] of graph.files) {
    if (result.fileVerdict === 'server-eligible' && !clientClosure.has(file)) {
      realizableServer.add(file);
      realizableServerBytes += result.sizeBytes;
    }
  }

  return { clientClosure, realizableServer, realizableServerBytes };
}

/**
 * Compute the minimal `'use client'` frontier: the topmost client files. A
 * client file is on the frontier iff NO other client file imports it — i.e.
 * its client-ness isn't already inherited from a client importer. Marking only
 * these files is the smallest directive set that is still correct, because
 * `'use client'` propagates to a module's imports.
 */
export function computeFrontier(
  graph: ComponentGraph,
  clientClosure: ReadonlySet<string>,
): Set<string> {
  // Which client files are imported by some *client* file (and thus inherit the directive)?
  const importedByClient = new Set<string>();
  for (const file of clientClosure) {
    const node = graph.files.get(file);
    if (!node) continue;
    for (const imported of node.imports) {
      if (clientClosure.has(imported)) importedByClient.add(imported);
    }
  }
  // Frontier = client files that no client file imports.
  const frontier = new Set<string>();
  for (const file of clientClosure) {
    if (!importedByClient.has(file)) frontier.add(file);
  }
  return frontier;
}
