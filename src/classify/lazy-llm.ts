/**
 * LLM Lazy Optimization — IR schema, response schema, system prompt, and merge logic.
 *
 * Defines the compact IR sent to the LLM for the ~20% of decisions that static
 * analysis can't make well: Suspense grouping, cross-component state awareness,
 * and prefetch strategy refinement.
 *
 * Supports batched multi-module analysis — a single LLM call can process
 * candidates from every module in the build for cross-module awareness.
 */

import type { LazyCandidate } from '../types.js';

// ── Single-module IR (building block) ───────────────────────────────────

export interface LazyIR {
  /** The parent component being analyzed */
  parent: string;
  file: string;

  /** Child components that passed deterministic filtering */
  candidates: Array<{
    name: string;
    source: string;
    jsxPosition: number;
    conditional: boolean;

    /** From ComponentProfile (if available) */
    hasHandlers: boolean;
    hasState: boolean;
    hasEffects: boolean;
    handlerCount: number;
    estimatedSize: number;

    /** Heuristic assignment (LLM can override) */
    heuristicPrefetch: string;
    heuristicReason: string;
  }>;

  /** Components that were kept static (for LLM awareness) */
  keptStatic: Array<{
    name: string;
    reason: string;
  }>;

  /** Cross-component state relationships detected statically */
  sharedState: Array<{
    components: string[];
    stateDescription: string;
  }>;
}

// ── Batched IR (multiple modules in one LLM call) ───────────────────────

export interface BatchedLazyIR {
  /** All modules with lazy candidates in this build */
  modules: LazyIR[];
  /** Total candidate count across all modules */
  totalCandidates: number;
}

// ── Response FROM the LLM ────────────────────────────────────────────────

/** Per-candidate decision from the LLM */
export interface LazyLLMDecision {
  name: string;
  /** Override the heuristic strategy (or confirm it) */
  prefetch: 'immediate' | 'viewport' | 'interaction' | 'idle';
  /** Group ID — components with same group share a Suspense boundary */
  suspenseGroup: string | null;
  /** Confidence 0-1 that this decision is correct */
  confidence: number;
  /** Brief reason */
  reason: string;
}

/** Single-module LLM response */
export interface LazyLLMResponse {
  /** Optimized decisions for each candidate */
  decisions: LazyLLMDecision[];

  /** Any candidates the LLM thinks should be moved to keepStatic */
  overrideToStatic: Array<{
    name: string;
    reason: string;
  }>;

  /** Cross-component insights */
  insights: string[];
}

/** Batched response — one LazyLLMResponse per module, keyed by file path */
export interface BatchedLazyLLMResponse {
  modules: Record<string, LazyLLMResponse>;
  /** Global insights that span multiple modules */
  globalInsights: string[];
}

// ── System prompt ────────────────────────────────────────────────────────

export const LAZY_SYSTEM_PROMPT = `You are a React performance optimization assistant. You receive a JSON object describing a React component's child imports that have been identified as candidates for React.lazy() wrapping.

Your job:
1. Confirm or override the heuristic prefetch strategy for each candidate
2. Assign suspense groups — components that share state or must hydrate together should share a group ID
3. Flag any candidates that should actually be kept static (the heuristic may have been too aggressive)

Grouping rules:
- Components sharing mutable state MUST be in the same Suspense group
- Adjacent siblings with no shared state CAN be grouped (reduces boundaries)
- Conditionally rendered components should NEVER be grouped with unconditionally rendered ones
- Context consumers that depend on the same provider can be grouped

Strategy definitions:
- "immediate": Component is critical path, must hydrate ASAP
- "viewport": Component is below fold but visible on scroll
- "interaction": Component only renders on user action (conditional)
- "idle": Component can load when browser is idle (low priority, background)

Respond with ONLY a valid JSON object matching this schema:
{
  "decisions": [{ "name": string, "prefetch": string, "suspenseGroup": string|null, "confidence": number, "reason": string }],
  "overrideToStatic": [{ "name": string, "reason": string }],
  "insights": [string]
}`;

export const LAZY_BATCHED_SYSTEM_PROMPT = `You are a React performance optimization assistant. You receive a JSON object containing MULTIPLE modules from a single build, each with child component imports identified as candidates for React.lazy() wrapping.

Because you see ALL modules at once, you can make cross-module decisions:
- Detect shared state between components in different modules
- Identify common import patterns across the application
- Make globally consistent Suspense grouping decisions

Your job for EACH module:
1. Confirm or override the heuristic prefetch strategy for each candidate
2. Assign suspense groups — components that share state or must hydrate together should share a group ID
3. Flag any candidates that should actually be kept static (the heuristic may have been too aggressive)

Grouping rules:
- Components sharing mutable state MUST be in the same Suspense group
- Adjacent siblings with no shared state CAN be grouped (reduces boundaries)
- Conditionally rendered components should NEVER be grouped with unconditionally rendered ones
- Context consumers that depend on the same provider can be grouped
- Components imported in MULTIPLE modules should have consistent strategies

Strategy definitions:
- "immediate": Component is critical path, must hydrate ASAP
- "viewport": Component is below fold but visible on scroll
- "interaction": Component only renders on user action (conditional)
- "idle": Component can load when browser is idle (low priority, background)

Respond with ONLY a valid JSON object matching this schema:
{
  "modules": {
    "<file_path>": {
      "decisions": [{ "name": string, "prefetch": string, "suspenseGroup": string|null, "confidence": number, "reason": string }],
      "overrideToStatic": [{ "name": string, "reason": string }],
      "insights": [string]
    }
  },
  "globalInsights": [string]
}`;

/**
 * Build a BatchedLazyIR from multiple modules' stashed data.
 * Used by the plugin to construct the single LLM call payload.
 */
export function buildBatchedIR(
  moduleData: Array<{ ir: LazyIR }>,
): BatchedLazyIR {
  const modules = moduleData.map((d) => d.ir);
  const totalCandidates = modules.reduce(
    (sum, m) => sum + m.candidates.length,
    0,
  );
  return { modules, totalCandidates };
}

/**
 * Apply a batched LLM response to each module's candidates.
 * Returns a map of file path → merged results.
 */
export function mergeBatchedLLMDecisions(
  moduleStash: Map<string, { candidates: LazyCandidate[]; keepStatic: Array<{ localName: string; source: string; reason: string }> }>,
  batchedResponse: BatchedLazyLLMResponse,
  confidenceThreshold: number = 0.8,
): Map<string, { updated: LazyCandidate[]; movedToStatic: Array<{ localName: string; source: string; reason: string }>; insights: string[] }> {
  const results = new Map<string, { updated: LazyCandidate[]; movedToStatic: Array<{ localName: string; source: string; reason: string }>; insights: string[] }>();

  for (const [filePath, stashed] of moduleStash) {
    const moduleResponse = batchedResponse.modules[filePath];
    if (!moduleResponse) {
      // LLM didn't return data for this module — keep heuristic decisions
      results.set(filePath, {
        updated: stashed.candidates,
        movedToStatic: [],
        insights: [],
      });
      continue;
    }

    const { updated, movedToStatic } = mergeLLMDecisions(
      stashed.candidates,
      moduleResponse,
      confidenceThreshold,
    );

    results.set(filePath, {
      updated,
      movedToStatic,
      insights: moduleResponse.insights ?? [],
    });
  }

  return results;
}

// ── Merge function ───────────────────────────────────────────────────────

/**
 * Merge LLM optimization response into the heuristic lazy candidates.
 *
 * Called after inference returns. Updates prefetch strategies, suspense
 * groups, and filters out any candidates the LLM thinks should be static.
 */
export function mergeLLMDecisions(
  candidates: LazyCandidate[],
  llmResponse: LazyLLMResponse,
  confidenceThreshold: number = 0.8,
): { updated: LazyCandidate[]; movedToStatic: Array<{ localName: string; source: string; reason: string }> } {
  const movedToStatic: Array<{ localName: string; source: string; reason: string }> = [];

  // Build lookup from LLM decisions
  const decisionMap = new Map(
    llmResponse.decisions.map((d) => [d.name, d]),
  );

  const remaining: LazyCandidate[] = [];

  for (const candidate of candidates) {
    // Check if LLM wants to move this to static
    const override = llmResponse.overrideToStatic.find(
      (o) => o.name === candidate.localName,
    );
    if (override) {
      movedToStatic.push({
        localName: candidate.localName,
        source: candidate.source,
        reason: `LLM override: ${override.reason}`,
      });
      continue;
    }

    // Apply LLM decision if confidence is above threshold
    const decision = decisionMap.get(candidate.localName);
    if (decision && decision.confidence >= confidenceThreshold) {
      candidate.prefetch = decision.prefetch;
      candidate.suspenseGroup = decision.suspenseGroup;
      candidate.reason = `LLM: ${decision.reason}`;
    }

    remaining.push(candidate);
  }

  return { updated: remaining, movedToStatic };
}
