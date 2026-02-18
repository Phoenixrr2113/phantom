import type { Node, SourceLocation } from 'estree';

/**
 * Add `range` and `loc` properties to all AST nodes.
 *
 * OXC's parser outputs `start`/`end` byte offsets on nodes, but:
 * - eslint-scope expects `range: [start, end]` (ESTree range convention)
 * - esrap needs `loc: { start: { line, column }, end: { line, column } }` for source maps
 *
 * This function walks the AST and patches each node in-place.
 */
export function addASTMetadata(node: unknown, sourceCode: string): void {
  const lineStarts = buildLineStartTable(sourceCode);
  addMetadataRecursive(node, lineStarts);
}

// ── Line/column computation ─────────────────────────────────────────────

/**
 * Build a table of byte offsets where each line starts.
 * lineStarts[i] = byte offset of the start of line i+1 (0-indexed internally).
 */
function buildLineStartTable(source: string): number[] {
  const lineStarts = [0]; // line 1 starts at offset 0
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) { // '\n'
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

/**
 * Convert a byte offset to an ESTree position.
 * ESTree uses 1-based lines and 0-based columns.
 */
function offsetToPosition(
  offset: number,
  lineStarts: number[],
): { line: number; column: number } {
  // Binary search for the line containing this offset
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return {
    line: lo + 1,       // 1-based
    column: offset - lineStarts[lo], // 0-based
  };
}

// ── Recursive AST walker ────────────────────────────────────────────────

function addMetadataRecursive(node: unknown, lineStarts: number[]): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      addMetadataRecursive(child, lineStarts);
    }
    return;
  }

  const obj = node as Record<string, unknown>;

  // Only process AST nodes (objects with a `type` string property)
  if (typeof obj.type !== 'string') {
    return;
  }

  // Add range and loc if start/end byte offsets are present
  if (typeof obj.start === 'number' && typeof obj.end === 'number') {
    const start = obj.start as number;
    const end = obj.end as number;

    (obj as unknown as Node & { range: [number, number] }).range = [start, end];

    (obj as unknown as Node).loc = {
      start: offsetToPosition(start, lineStarts),
      end: offsetToPosition(end, lineStarts),
    } as SourceLocation;
  }

  // Recurse into all properties
  for (const key of Object.keys(obj)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') {
      continue;
    }
    addMetadataRecursive(obj[key], lineStarts);
  }
}
