import type { FunctionDependency } from '../types.js';
import { isBrowserGlobal, isPureGlobal } from './browser-globals.js';
import { CLIENT_ONLY_HOOKS } from './react-patterns.js';

export interface TaintResult {
  /** Whether this function is tainted (references browser APIs) */
  tainted: boolean;
  /** Which browser globals caused the taint */
  browserGlobals: string[];
  /** Which globals are pure (Math, JSON, etc.) */
  pureGlobals: string[];
  /** Which globals are unknown (not in either list) */
  unknownGlobals: string[];
}

/**
 * Pass 1: Taint Analysis
 *
 * Classifies each function's global references as browser-tainted,
 * pure, or unknown.
 *
 * A function is "tainted" if it references any browser-only global
 * (window, document, localStorage, etc.).
 */
export function analyzeTaint(fn: FunctionDependency): TaintResult {
  const browserGlobals: string[] = [];
  const pureGlobals: string[] = [];
  const unknownGlobals: string[] = [];

  for (const global of fn.globals) {
    if (isBrowserGlobal(global)) {
      browserGlobals.push(global);
    } else if (isPureGlobal(global)) {
      pureGlobals.push(global);
    } else {
      unknownGlobals.push(global);
    }
  }

  return {
    tainted: browserGlobals.length > 0,
    browserGlobals,
    pureGlobals,
    unknownGlobals,
  };
}

/**
 * Check if a function is inside a client-only hook callback.
 * This requires context about the parent call expression.
 *
 * For now, this is a simplified check based on imported hook names
 * in the function's dependency list.
 */
export function isInClientOnlyHookContext(fn: FunctionDependency): boolean {
  return fn.imported.some((name) => CLIENT_ONLY_HOOKS.has(name));
}

/**
 * Propagate taint through function call chains.
 *
 * If function A calls function B and B is tainted, then A is tainted.
 * This requires knowledge of the full call graph, which we build from
 * the function dependency information.
 */
export function propagateTaint(
  functions: FunctionDependency[],
  taintResults: Map<FunctionDependency, TaintResult>,
): void {
  let changed = true;

  while (changed) {
    changed = false;
    for (const fn of functions) {
      const result = taintResults.get(fn);
      if (!result || result.tainted) continue;

      // Check if any captured variable is a tainted function
      for (const captured of fn.captured) {
        const capturedFn = functions.find((f) => f.name === captured);
        if (capturedFn) {
          const capturedResult = taintResults.get(capturedFn);
          if (capturedResult?.tainted) {
            result.tainted = true;
            result.browserGlobals.push(`(via ${captured})`);
            changed = true;
          }
        }
      }
    }
  }
}
