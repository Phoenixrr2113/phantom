import type { Node } from 'estree';
import { createHash } from 'node:crypto';
import type { ClassifiedSegment, FunctionDependency, SegmentClassification } from '../types.js';
import type { TaintResult } from './taint.js';
import type { PurityResult } from './purity.js';
import { EXTRACTABLE_HOOKS, CLIENT_ONLY_HOOKS } from './react-patterns.js';

interface ClassificationInput {
  fn: FunctionDependency;
  taint: TaintResult;
  purity: PurityResult;
  /** The parent call expression name, if this is a hook callback */
  parentHook: string | null;
  /** The JSX event prop name, if this function is used exclusively as an event handler */
  parentEventProp: string | null;
  /** Source code for content hashing */
  sourceCode: string;
  /** File path for naming */
  filePath: string;
  /** Index among siblings for disambiguation */
  index: number;
  /** The AST node for this function (for JSX detection) */
  astNode: Node | null;
}

/**
 * Pass 3: Boundary Detection
 *
 * Determines the final classification for each function and whether
 * it's an extraction candidate.
 */
export function classifySegment(input: ClassificationInput): ClassifiedSegment {
  const { fn, taint, purity, parentHook, parentEventProp, sourceCode, filePath, index, astNode } = input;
  const codeSlice = sourceCode.slice(fn.span.start, fn.span.end);
  const id = generateSegmentId(filePath, codeSlice);
  const name = generateName(fn, filePath, index);

  let classification: SegmentClassification;
  let confidence: number;
  const reasons: string[] = [];

  // Rule 0: If used exclusively as a JSX event handler prop, it's an event handler
  // This fires before taint analysis because event handlers are extracted regardless
  // of whether they touch browser APIs (they all do — that's the point)
  if (parentEventProp) {
    classification = 'EventHandler';
    confidence = 0.9;
    reasons.push(`Event handler for ${parentEventProp}`);
  }
  // Rule 1: If inside a client-only hook (useEffect, useLayoutEffect), it's client
  else if (parentHook && CLIENT_ONLY_HOOKS.has(parentHook)) {
    classification = 'ClientInteractive';
    confidence = 1.0;
    reasons.push(`Inside ${parentHook} callback (client-side effect)`);
  }
  // Rule 2: If tainted by browser globals, it's client
  else if (taint.tainted) {
    classification = 'ClientInteractive';
    confidence = 0.95;
    reasons.push(`References browser APIs: ${taint.browserGlobals.join(', ')}`);
  }
  // Rule 3: If pure and inside an extractable hook (useMemo, useCallback), it's pure computation
  else if (purity.pure && parentHook && EXTRACTABLE_HOOKS.has(parentHook)) {
    classification = 'PureComputation';
    confidence = 0.9;
    reasons.push(`Pure computation inside ${parentHook}`);
    reasons.push(...purity.reasons);
  }
  // Rule 3.5: If function contains JSX, it's a React component — not extractable
  else if (astNode && containsJSX(astNode)) {
    classification = 'Shared';
    confidence = 0.0;
    reasons.push('React component (contains JSX) — not extractable');
  }
  // Rule 4: If pure and a named helper function, it's pure computation
  else if (purity.pure && fn.name !== '<anonymous>') {
    classification = 'PureComputation';
    confidence = 0.85;
    reasons.push('Pure named helper function');
    reasons.push(...purity.reasons);
  }
  // Rule 5: If pure but anonymous and not in a hook, it's shared
  else if (purity.pure) {
    classification = 'Shared';
    confidence = 0.7;
    reasons.push('Pure anonymous function — may be used in both contexts');
    reasons.push(...purity.reasons);
  }
  // Rule 6a: Cross-environment globals (fetch, crypto, etc.) — ambiguous
  else if (taint.ambiguousGlobals.length > 0) {
    classification = 'Ambiguous';
    confidence = 0.5;
    reasons.push(`Cross-environment APIs: ${taint.ambiguousGlobals.join(', ')}`);
    reasons.push('Available in both browser and Node.js — cannot determine intent');
  }
  // Rule 6b: Unknown globals — ambiguous
  else if (taint.unknownGlobals.length > 0) {
    classification = 'Ambiguous';
    confidence = 0.5;
    reasons.push(`Unknown globals: ${taint.unknownGlobals.join(', ')}`);
    reasons.push('Cannot determine if these are browser-only APIs');
  }
  // Rule 7: Default — ambiguous, leave on client
  else {
    classification = 'Ambiguous';
    confidence = 0.5;
    reasons.push('Could not determine classification');
    reasons.push(...purity.reasons);
  }

  return {
    id,
    name,
    classification,
    confidence,
    reasons,
    dependencies: [...fn.captured, ...fn.imported],
    span: fn.span,
  };
}

function generateSegmentId(_filePath: string, code: string): string {
  // Content-addressable: hash only the code, not the file path.
  // This ensures deterministic IDs across build environments (CI vs local)
  // and enables deduplication of identical handler bodies across files.
  const hash = createHash('sha256')
    .update(code)
    .digest('hex')
    .slice(0, 12);
  return `seg_${hash}`;
}

function generateName(fn: FunctionDependency, filePath: string, index: number): string {
  const base = filePath.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_');
  if (fn.name !== '<anonymous>') {
    return `${base}_${fn.name}`;
  }
  return `${base}_anon_${index}`;
}

/**
 * Check if an AST node contains any JSX elements or fragments.
 * Functions containing JSX are React components and should not be extracted.
 */
function containsJSX(node: Node): boolean {
  let found = false;
  walkNodeLocal(node, (n) => {
    if (found) return;
    if ((n.type as string).startsWith('JSX')) found = true;
  });
  return found;
}

function walkNodeLocal(node: unknown, callback: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) {
      walkNodeLocal(child, callback);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type !== 'string') return;
  callback(obj as unknown as Node);
  for (const key of Object.keys(obj)) {
    if (key === 'type') continue;
    walkNodeLocal(obj[key], callback);
  }
}
