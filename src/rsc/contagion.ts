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

/** Files reachable from `starts` by following import edges, staying within `closure` (includes starts). */
function reachableWithin(
  starts: Iterable<string>,
  graph: ComponentGraph,
  closure: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of starts) {
    if (!seen.has(s)) {
      seen.add(s);
      queue.push(s);
    }
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    const node = graph.files.get(file);
    if (!node) continue;
    for (const imported of node.imports) {
      if (closure.has(imported) && !seen.has(imported)) {
        seen.add(imported);
        queue.push(imported);
      }
    }
  }
  return seen;
}

/**
 * Minimal `'use client'` frontier: the smallest set of files to mark such that
 * every client file ends up client (the directive propagates to a module's
 * imports). Phase 1 takes the topmost client nodes (those no client file
 * imports) — minimal and complete for acyclic graphs. Phase 2 covers client
 * import CYCLES that have no acyclic client entry: such a cycle's members all
 * import one another, so phase 1 omits them all; we add one representative per
 * still-uncovered cycle so no client file is ever left without a directive.
 *
 * Guarantee: the returned set always covers the entire client closure (safe —
 * never omits a needed directive). Minimal on acyclic graphs and for a single
 * cycle; for a client file inside a cycle it marks one representative.
 */
export function computeFrontier(
  graph: ComponentGraph,
  clientClosure: ReadonlySet<string>,
): Set<string> {
  // Phase 1: topmost client nodes (no client importer).
  const importedByClient = new Set<string>();
  for (const file of clientClosure) {
    const node = graph.files.get(file);
    if (!node) continue;
    for (const imported of node.imports) {
      if (clientClosure.has(imported)) importedByClient.add(imported);
    }
  }
  const frontier = new Set<string>();
  for (const file of clientClosure) {
    if (!importedByClient.has(file)) frontier.add(file);
  }

  // Phase 2: ensure full coverage of the closure (handles client cycles with no
  // acyclic entry, which phase 1 leaves entirely uncovered).
  const covered = reachableWithin(frontier, graph, clientClosure);
  const uncovered = [...clientClosure].filter((f) => !covered.has(f)).sort();
  for (const file of uncovered) {
    if (covered.has(file)) continue; // already covered by a representative added earlier
    frontier.add(file);
    for (const reached of reachableWithin([file], graph, clientClosure)) covered.add(reached);
  }
  return frontier;
}
