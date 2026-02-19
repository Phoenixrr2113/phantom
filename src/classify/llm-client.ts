/**
 * Cerebras LLM client for lazy component optimization.
 *
 * Uses the Cerebras Cloud API (OpenAI-compatible) with a Qwen model
 * for fast structured inference. No SDK dependency — raw fetch.
 *
 * Supports both single-module and batched multi-module calls.
 * The batched path sends ALL modules' candidates in a single API request
 * for cross-module awareness and minimal latency.
 */

import type { LazyCandidate, ComponentProfile, LazyCandidateResult } from '../types.js';
import {
  type LazyIR,
  type BatchedLazyIR,
  type LazyLLMResponse,
  type BatchedLazyLLMResponse,
  LAZY_SYSTEM_PROMPT,
  LAZY_BATCHED_SYSTEM_PROMPT,
  mergeLLMDecisions,
  mergeBatchedLLMDecisions,
} from './lazy-llm.js';

export const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
export const DEFAULT_MODEL = 'qwen-3-32b';

/**
 * Call the Cerebras API to refine lazy detection heuristics for a single module.
 *
 * Returns the merged candidates with LLM overrides applied,
 * or the original candidates if the API call fails.
 */
export async function refineLazyCandidatesWithLLM(
  candidates: LazyCandidate[],
  keepStatic: LazyCandidateResult['keepStatic'],
  filePath: string,
  parentComponentName: string,
  componentProfiles: Map<string, ComponentProfile> | undefined,
  apiKey: string,
  model: string = DEFAULT_MODEL,
  confidenceThreshold: number = 0.8,
): Promise<{
  candidates: LazyCandidate[];
  movedToStatic: Array<{ localName: string; source: string; reason: string }>;
  insights: string[];
}> {
  // Build the compact IR
  const ir = buildLazyIR(candidates, keepStatic, filePath, parentComponentName, componentProfiles);

  try {
    const llmResponse = await callCerebras(ir, apiKey, model);

    const { updated, movedToStatic } = mergeLLMDecisions(
      candidates,
      llmResponse,
      confidenceThreshold,
    );

    return {
      candidates: updated,
      movedToStatic,
      insights: llmResponse.insights ?? [],
    };
  } catch (err) {
    // LLM failure is non-fatal — fall back to heuristic decisions
    console.warn(
      `[phantom] LLM refinement failed, using heuristics:`,
      err instanceof Error ? err.message : err,
    );
    return { candidates, movedToStatic: [], insights: [] };
  }
}

/**
 * Batch-refine lazy candidates across ALL modules in a single LLM call.
 *
 * Takes the accumulated stash from every module's transform pass and sends
 * one batched request. Returns merged results keyed by file path, or
 * falls back to heuristic decisions on failure.
 */
export async function refineLazyCandidatesBatched(
  moduleStash: Map<string, {
    candidates: LazyCandidate[];
    keepStatic: Array<{ localName: string; source: string; reason: string }>;
    parentComponent: string;
    componentProfiles: Map<string, ComponentProfile> | undefined;
  }>,
  apiKey: string,
  model: string = DEFAULT_MODEL,
  confidenceThreshold: number = 0.8,
): Promise<{
  results: Map<string, {
    updated: LazyCandidate[];
    movedToStatic: Array<{ localName: string; source: string; reason: string }>;
    insights: string[];
  }>;
  globalInsights: string[];
}> {
  // Build batched IR from all modules
  const batchedIR = buildBatchedIR(moduleStash);

  try {
    const batchedResponse = await callCebrasBatched(batchedIR, apiKey, model);

    // Extract just the candidates/keepStatic for the merge function
    const mergeInput = new Map<string, { candidates: LazyCandidate[]; keepStatic: Array<{ localName: string; source: string; reason: string }> }>();
    for (const [filePath, stashed] of moduleStash) {
      mergeInput.set(filePath, {
        candidates: stashed.candidates,
        keepStatic: stashed.keepStatic,
      });
    }

    const results = mergeBatchedLLMDecisions(
      mergeInput,
      batchedResponse,
      confidenceThreshold,
    );

    return {
      results,
      globalInsights: batchedResponse.globalInsights ?? [],
    };
  } catch (err) {
    // LLM failure is non-fatal — fall back to heuristic decisions for all modules
    console.warn(
      `[phantom] Batched LLM refinement failed, using heuristics for all modules:`,
      err instanceof Error ? err.message : err,
    );

    const results = new Map<string, {
      updated: LazyCandidate[];
      movedToStatic: Array<{ localName: string; source: string; reason: string }>;
      insights: string[];
    }>();

    for (const [filePath, stashed] of moduleStash) {
      results.set(filePath, {
        updated: stashed.candidates,
        movedToStatic: [],
        insights: [],
      });
    }

    return { results, globalInsights: [] };
  }
}

// ── IR builders ──────────────────────────────────────────────────────────

export function buildLazyIR(
  candidates: LazyCandidate[],
  keepStatic: LazyCandidateResult['keepStatic'],
  filePath: string,
  parentComponentName: string,
  componentProfiles: Map<string, ComponentProfile> | undefined,
): LazyIR {
  return {
    parent: parentComponentName,
    file: filePath,
    candidates: candidates.map((c) => {
      const profile = componentProfiles?.get(c.source);
      return {
        name: c.localName,
        source: c.source,
        jsxPosition: c.jsxPosition,
        conditional: c.conditional,
        hasHandlers: profile?.hasHandlers ?? false,
        hasState: profile?.hasState ?? false,
        hasEffects: profile?.hasEffects ?? false,
        handlerCount: profile?.handlerCount ?? 0,
        estimatedSize: profile?.estimatedSize ?? 0,
        heuristicPrefetch: c.prefetch,
        heuristicReason: c.reason,
      };
    }),
    keptStatic: keepStatic.map((s) => ({
      name: s.localName,
      reason: s.reason,
    })),
    sharedState: [], // Static analysis for shared state is a future enhancement
  };
}

function buildBatchedIR(
  moduleStash: Map<string, {
    candidates: LazyCandidate[];
    keepStatic: Array<{ localName: string; source: string; reason: string }>;
    parentComponent: string;
    componentProfiles: Map<string, ComponentProfile> | undefined;
  }>,
): BatchedLazyIR {
  const modules: LazyIR[] = [];
  let totalCandidates = 0;

  for (const [filePath, stashed] of moduleStash) {
    const ir = buildLazyIR(
      stashed.candidates,
      stashed.keepStatic,
      filePath,
      stashed.parentComponent,
      stashed.componentProfiles,
    );
    modules.push(ir);
    totalCandidates += stashed.candidates.length;
  }

  return { modules, totalCandidates };
}

// ── Cerebras API calls ──────────────────────────────────────────────────

async function callCerebras(
  ir: LazyIR,
  apiKey: string,
  model: string,
): Promise<LazyLLMResponse> {
  const response = await fetch(CEREBRAS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: LAZY_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(ir, null, 2) },
      ],
      temperature: 0.1,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Cerebras API error ${response.status}: ${body}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from Cerebras API');
  }

  const parsed = JSON.parse(content) as LazyLLMResponse;

  // Validate basic structure
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('Invalid LLM response: missing decisions array');
  }

  return parsed;
}

async function callCebrasBatched(
  ir: BatchedLazyIR,
  apiKey: string,
  model: string,
): Promise<BatchedLazyLLMResponse> {
  // Scale max_tokens with the number of modules — each module needs ~500 tokens
  const maxTokens = Math.min(8192, 1024 + ir.modules.length * 512);

  const response = await fetch(CEREBRAS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: LAZY_BATCHED_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(ir, null, 2) },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Cerebras API error ${response.status}: ${body}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from Cerebras API');
  }

  const parsed = JSON.parse(content) as BatchedLazyLLMResponse;

  // Validate basic structure
  if (!parsed.modules || typeof parsed.modules !== 'object') {
    throw new Error('Invalid batched LLM response: missing modules object');
  }

  // Validate each module response
  for (const [filePath, moduleResponse] of Object.entries(parsed.modules)) {
    if (!Array.isArray(moduleResponse.decisions)) {
      throw new Error(`Invalid batched LLM response: missing decisions array for ${filePath}`);
    }
  }

  return parsed;
}
