/**
 * Shared type contracts for the RSC readiness analysis pipeline.
 *
 * Every unit (classifier, graph resolver, contagion engine, rescue/hazard
 * detector, report emitter) imports from here. Report-only, read-only — these
 * describe analysis results, never a transform.
 */

/** A file/component's React Server Components verdict. */
export type RscVerdict = 'server-eligible' | 'must-be-client';

/** Per-component RSC verdict with a human-readable reason and source size. */
export interface RscComponentResult {
  name: string;
  verdict: RscVerdict;
  reason: string; // e.g. "uses useState" / "pure props→JSX"
  sizeBytes: number; // from function span
}

/**
 * Per-file RSC result. `'use client'` is a file-level directive, so the file
 * verdict is a rollup of its components:
 * - `server-eligible`  — has components, all server-eligible
 * - `must-be-client`   — has at least one must-be-client component
 * - `mixed`            — has both (a split candidate)
 * - `non-component`    — no detected components (util/types module)
 */
export interface RscFileResult {
  file: string; // absolute path
  hasComponents: boolean;
  fileVerdict: RscVerdict | 'mixed' | 'non-component';
  components: RscComponentResult[];
  imports: string[]; // resolved absolute paths of component imports
  sizeBytes: number; // file source size
  /** Local imported binding name (the JSX tag) → resolved absolute file. Populated by buildComponentGraph. */
  importedComponents?: Map<string, string>;
}

/** The resolved component import graph plus an edge-resolution coverage stat. */
export interface ComponentGraph {
  files: Map<string, RscFileResult>;
  edgeResolution: number; // 0..1 fraction of relative/alias imports resolved
}

/** The whole-codebase RSC migration map (the product). */
export interface RscReport {
  componentFiles: number;
  edgeResolutionPct: number;
  serverEligibleUpperBound: number;
  realizableServerFiles: number;
  realizableServerBytes: number;
  realizableServerPctBytes: number;
  clientFrontier: string[]; // minimal set of files to mark 'use client'
  rescues: Array<{ file: string; trappedBy: string; hint: string }>;
  hazards: Array<{ file: string; prop: string; kind: string }>;
}
