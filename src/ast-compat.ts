import type { Node } from 'estree';

/**
 * Add `range` property to all AST nodes for eslint-scope compatibility.
 *
 * OXC's parser outputs `start`/`end` properties on nodes, but eslint-scope
 * expects `range: [start, end]` (the ESTree `range` convention). This function
 * walks the AST and patches each node in-place.
 */
export function addRanges(node: unknown): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      addRanges(child);
    }
    return;
  }

  const obj = node as Record<string, unknown>;

  // Only process AST nodes (objects with a `type` string property)
  if (typeof obj.type !== 'string') {
    return;
  }

  // Add range if start/end are present
  if (typeof obj.start === 'number' && typeof obj.end === 'number') {
    (obj as unknown as Node & { range: [number, number] }).range = [
      obj.start as number,
      obj.end as number,
    ];
  }

  // Recurse into all properties
  for (const key of Object.keys(obj)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      continue;
    }
    addRanges(obj[key]);
  }
}
