import type { FunctionDependency } from '../types.js';
import type { TaintResult } from './taint.js';

export interface PurityResult {
  /** Whether this function is pure computation (no side effects, no browser APIs) */
  pure: boolean;
  /** Reasons why it's pure or impure */
  reasons: string[];
}

/**
 * Pass 2: Purity Analysis
 *
 * Determines if a non-tainted function is "pure computation" —
 * meaning it only transforms data without side effects.
 *
 * A function is considered pure if:
 * - It is NOT tainted (no browser globals)
 * - It has no unknown globals (conservative)
 * - Its captured variables are from data flow (not side-effectful)
 */
export function analyzePurity(
  fn: FunctionDependency,
  taint: TaintResult,
): PurityResult {
  const reasons: string[] = [];

  // If tainted, definitely not pure
  if (taint.tainted) {
    reasons.push(`References browser APIs: ${taint.browserGlobals.join(', ')}`);
    return { pure: false, reasons };
  }

  // If there are unknown globals, be conservative
  if (taint.unknownGlobals.length > 0) {
    reasons.push(`References unknown globals: ${taint.unknownGlobals.join(', ')}`);
    return { pure: false, reasons };
  }

  // If the function only uses:
  // - local variables
  // - captured variables (from parent scope — data flow)
  // - imported modules (from dependencies)
  // - pure globals (Math, JSON, etc.)
  // Then it's a pure computation candidate.

  if (fn.globals.length === 0 || taint.pureGlobals.length === fn.globals.length) {
    reasons.push('No browser APIs, only pure globals');
  }

  if (fn.captured.length > 0) {
    reasons.push(`Captures: ${fn.captured.join(', ')}`);
  }

  if (fn.imported.length > 0) {
    reasons.push(`Uses imports: ${fn.imported.join(', ')}`);
  }

  reasons.push('Function body is pure computation');
  return { pure: true, reasons };
}
