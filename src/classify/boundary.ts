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
  /** Source code for content hashing */
  sourceCode: string;
  /** File path for naming */
  filePath: string;
  /** Index among siblings for disambiguation */
  index: number;
}

/**
 * Pass 3: Boundary Detection
 *
 * Determines the final classification for each function and whether
 * it's an extraction candidate.
 */
export function classifySegment(input: ClassificationInput): ClassifiedSegment {
  const { fn, taint, purity, parentHook, sourceCode, filePath, index } = input;
  const codeSlice = sourceCode.slice(fn.span.start, fn.span.end);
  const id = generateSegmentId(filePath, codeSlice);
  const name = generateName(fn, filePath, index);

  let classification: SegmentClassification;
  let confidence: number;
  const reasons: string[] = [];

  // Rule 1: If inside a client-only hook (useEffect, useLayoutEffect), it's client
  if (parentHook && CLIENT_ONLY_HOOKS.has(parentHook)) {
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
  // Rule 3: If pure and inside an extractable hook (useMemo, useCallback), it's server
  else if (purity.pure && parentHook && EXTRACTABLE_HOOKS.has(parentHook)) {
    classification = 'ServerCompute';
    confidence = 0.9;
    reasons.push(`Pure computation inside ${parentHook}`);
    reasons.push(...purity.reasons);
  }
  // Rule 4: If pure and a named helper function, it's server
  else if (purity.pure && fn.name !== '<anonymous>') {
    classification = 'ServerCompute';
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
  // Rule 6: Unknown globals — ambiguous
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

function generateSegmentId(filePath: string, code: string): string {
  const hash = createHash('sha256')
    .update(filePath)
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
