import { basename } from 'node:path';
import type { Node } from 'estree';
import { walkNode } from '../classify/index.js';
import type { AnalyzedModule } from '../types.js';
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

// ── Serialization Hazard Detection ────────────────────────────────────

export interface SerializationHazard {
  file: string;
  component: string; // the must-be-client component receiving the prop
  prop: string;      // attribute name
  kind: string;      // 'function' | 'class-instance'
}

/**
 * Classify a prop-value expression as a serialization hazard, or null if it is
 * serializable across the RSC server→client boundary. Functions and class
 * instances are NOT serializable; JSX elements, primitives, object literals,
 * and member expressions are left to deeper analysis and are not flagged in v1.
 */
function hazardKind(expr: Node, localFunctionNames: ReadonlySet<string>): string | null {
  switch (expr.type) {
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return 'function';
    case 'NewExpression':
      return 'class-instance';
    case 'Identifier':
      return localFunctionNames.has((expr as Node & { name: string }).name) ? 'function' : null;
    default:
      return null; // JSX elements, primitives, object literals, member exprs — not flagged in v1
  }
}

/**
 * Shallow serialization-hazard detection. Walks JSX usages of must-be-client
 * components (per `isClientComponent`) and flags props whose values are NOT
 * serializable across the RSC server→client boundary: function expressions,
 * identifiers bound to a local function, and `new X()` class instances.
 * React elements (JSX) and primitives ARE serializable and are intentionally
 * NOT flagged. Shallow: no type-flow, no deep object inspection, no
 * cross-module tracing — only locally-evident cases.
 */
export function findHazardsInModule(
  analyzed: AnalyzedModule,
  _code: string,
  file: string,
  isClientComponent: (tagName: string) => boolean,
): SerializationHazard[] {
  const hazards: SerializationHazard[] = [];
  const localFunctionNames = new Set<string>();
  for (const fn of analyzed.functions) {
    if (fn.name && fn.name !== '<anonymous>') localFunctionNames.add(fn.name);
  }

  walkNode(analyzed.ast, (node) => {
    if ((node.type as string) !== 'JSXOpeningElement') return;
    const el = node as unknown as { name?: { type?: string; name?: string }; attributes?: unknown[] };
    if (el.name?.type !== 'JSXIdentifier' || !el.name.name) return;
    const component = el.name.name;
    if (!isClientComponent(component)) return;

    for (const raw of el.attributes ?? []) {
      const attr = raw as { type?: string; name?: { name?: string }; value?: unknown };
      if (attr.type !== 'JSXAttribute' || !attr.name?.name) continue;
      const value = attr.value as { type?: string; expression?: Node } | null;
      if (!value || (value.type as string) !== 'JSXExpressionContainer') continue;
      const expr = value.expression;
      if (!expr) continue;
      const kind = hazardKind(expr, localFunctionNames);
      if (kind) hazards.push({ file, component, prop: attr.name.name, kind });
    }
  });

  return hazards;
}
