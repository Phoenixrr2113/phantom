import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeModule, parseModule } from '../src/analyzer.js';
import { detectLazyCandidates } from '../src/classify/index.js';
import {
  mergeLLMDecisions,
  mergeBatchedLLMDecisions,
  buildBatchedIR,
  type LazyLLMResponse,
  type BatchedLazyLLMResponse,
} from '../src/classify/lazy-llm.js';
import { refineLazyCandidatesWithLLM, refineLazyCandidatesBatched, CEREBRAS_API_URL } from '../src/classify/llm-client.js';
import { applyLazyTransforms } from '../src/extract/lazy-transform.js';
import type { LazyCandidate, ComponentProfile } from '../src/types.js';
import type { Program } from 'estree';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

// ── Test helpers ────────────────────────────────────────────────────────

/** Build a minimal LazyCandidate for test purposes */
function makeCandidate(overrides: Partial<LazyCandidate> & { localName: string; source: string }): LazyCandidate {
  return {
    importKind: 'named',
    importedName: overrides.localName,
    jsxUsages: [{ start: 0, end: 10 }],
    prefetch: 'viewport',
    suspenseGroup: null,
    conditional: false,
    jsxPosition: 2,
    reason: 'heuristic default',
    ...overrides,
  };
}

/** Build a mock Cerebras API response wrapping an LLM JSON response */
function mockCerebrasResponse(llmResponse: LazyLLMResponse): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify(llmResponse),
        },
      }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 1. HEURISTIC DETECTION — CheckoutPage fixture
// ══════════════════════════════════════════════════════════════════════════

describe('lazy detection (heuristic)', () => {
  const getResult = () => {
    const code = fixture('CheckoutPage.tsx');
    return analyzeModule(code, '/app/pages/CheckoutPage.tsx');
  };

  it('detects lazy candidates from CheckoutPage', () => {
    const result = getResult();
    expect(result.lazyCandidates).toBeDefined();
    expect(result.lazyCandidates!.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps CartProvider static (context provider)', () => {
    const result = getResult();
    const kept = result.lazyKeptStatic?.find((k) => k.localName === 'CartProvider');
    expect(kept).toBeDefined();
    expect(kept!.reason).toContain('Context provider');
  });

  it('keeps CartItems static (position 0, above fold)', () => {
    const result = getResult();
    const kept = result.lazyKeptStatic?.find((k) => k.localName === 'CartItems');
    expect(kept).toBeDefined();
    expect(kept!.reason).toContain('above fold');
  });

  it('keeps OrderSummary static (position 1, above fold)', () => {
    const result = getResult();
    const kept = result.lazyKeptStatic?.find((k) => k.localName === 'OrderSummary');
    expect(kept).toBeDefined();
    expect(kept!.reason).toContain('above fold');
  });

  it('lazifies PaymentForm at position 2 with viewport strategy', () => {
    const result = getResult();
    const pf = result.lazyCandidates?.find((c) => c.localName === 'PaymentForm');
    expect(pf).toBeDefined();
    expect(pf!.prefetch).toBe('viewport');
    expect(pf!.jsxPosition).toBe(2);
    expect(pf!.conditional).toBe(false);
  });

  it('lazifies AddressForm at position 3 with viewport strategy', () => {
    const result = getResult();
    const af = result.lazyCandidates?.find((c) => c.localName === 'AddressForm');
    expect(af).toBeDefined();
    expect(af!.prefetch).toBe('viewport');
    expect(af!.jsxPosition).toBe(3);
  });

  it('groups PaymentForm and AddressForm in the same Suspense boundary', () => {
    const result = getResult();
    const pf = result.lazyCandidates?.find((c) => c.localName === 'PaymentForm');
    const af = result.lazyCandidates?.find((c) => c.localName === 'AddressForm');
    expect(pf!.suspenseGroup).toBeDefined();
    expect(pf!.suspenseGroup).toBe(af!.suspenseGroup);
  });

  it('lazifies PromoCode as conditional with interaction strategy', () => {
    const result = getResult();
    const pc = result.lazyCandidates?.find((c) => c.localName === 'PromoCode');
    expect(pc).toBeDefined();
    expect(pc!.prefetch).toBe('interaction');
    expect(pc!.conditional).toBe(true);
    expect(pc!.suspenseGroup).toBeNull();
  });

  it('lazifies OrderHistory as conditional with interaction strategy', () => {
    const result = getResult();
    const oh = result.lazyCandidates?.find((c) => c.localName === 'OrderHistory');
    expect(oh).toBeDefined();
    expect(oh!.prefetch).toBe('interaction');
    expect(oh!.conditional).toBe(true);
  });

  it('does not lazify entry points (no exported component)', () => {
    const code = `
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import { App } from './App';
      ReactDOM.createRoot(document.getElementById('root')).render(<App />);
    `;
    const result = analyzeModule(code, '/app/main.tsx');
    expect(result.lazyCandidates).toBeUndefined();
  });

  it('does not lazify non-relative imports', () => {
    const code = `
      import React from 'react';
      import { Dialog } from '@headlessui/react';
      export default function Page() { return <Dialog open={true} />; }
    `;
    const result = analyzeModule(code, '/app/pages/page.tsx');
    // Dialog is from node_modules — should not be a lazy candidate
    expect(result.lazyCandidates).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. MERGE FUNCTION — mergeLLMDecisions unit tests
// ══════════════════════════════════════════════════════════════════════════

describe('mergeLLMDecisions', () => {
  it('applies LLM strategy overrides above confidence threshold', () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'PaymentForm', source: './PaymentForm', prefetch: 'viewport' }),
      makeCandidate({ localName: 'AddressForm', source: './AddressForm', prefetch: 'viewport' }),
    ];

    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'PaymentForm', prefetch: 'idle', suspenseGroup: 'checkout', confidence: 0.95, reason: 'shares state with AddressForm' },
        { name: 'AddressForm', prefetch: 'idle', suspenseGroup: 'checkout', confidence: 0.90, reason: 'shares state with PaymentForm' },
      ],
      overrideToStatic: [],
      insights: ['PaymentForm and AddressForm share checkout state'],
    };

    const { updated, movedToStatic } = mergeLLMDecisions(candidates, llmResponse, 0.8);

    expect(updated.length).toBe(2);
    expect(movedToStatic.length).toBe(0);

    const pf = updated.find((c) => c.localName === 'PaymentForm')!;
    expect(pf.prefetch).toBe('idle');
    expect(pf.suspenseGroup).toBe('checkout');
    expect(pf.reason).toContain('LLM');

    const af = updated.find((c) => c.localName === 'AddressForm')!;
    expect(af.prefetch).toBe('idle');
    expect(af.suspenseGroup).toBe('checkout');
  });

  it('ignores LLM decisions below confidence threshold', () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Widget', source: './Widget', prefetch: 'viewport' }),
    ];

    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'Widget', prefetch: 'immediate', suspenseGroup: null, confidence: 0.5, reason: 'not sure' },
      ],
      overrideToStatic: [],
      insights: [],
    };

    const { updated } = mergeLLMDecisions(candidates, llmResponse, 0.8);

    // Should keep the original heuristic strategy
    expect(updated[0].prefetch).toBe('viewport');
    expect(updated[0].reason).toBe('heuristic default');
  });

  it('moves candidates to static when LLM overrides', () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'TinyIcon', source: './TinyIcon', prefetch: 'viewport' }),
      makeCandidate({ localName: 'BigChart', source: './BigChart', prefetch: 'viewport' }),
    ];

    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'BigChart', prefetch: 'viewport', suspenseGroup: null, confidence: 0.95, reason: 'confirmed' },
      ],
      overrideToStatic: [
        { name: 'TinyIcon', reason: 'Component is only 200 bytes — Suspense overhead is larger' },
      ],
      insights: [],
    };

    const { updated, movedToStatic } = mergeLLMDecisions(candidates, llmResponse, 0.8);

    expect(updated.length).toBe(1);
    expect(updated[0].localName).toBe('BigChart');

    expect(movedToStatic.length).toBe(1);
    expect(movedToStatic[0].localName).toBe('TinyIcon');
    expect(movedToStatic[0].reason).toContain('LLM override');
  });

  it('handles empty LLM response gracefully', () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Foo', source: './Foo' }),
    ];

    const llmResponse: LazyLLMResponse = {
      decisions: [],
      overrideToStatic: [],
      insights: [],
    };

    const { updated, movedToStatic } = mergeLLMDecisions(candidates, llmResponse);

    expect(updated.length).toBe(1);
    expect(movedToStatic.length).toBe(0);
    // Original values preserved
    expect(updated[0].prefetch).toBe('viewport');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. FULL LLM PIPELINE — mocked fetch
// ══════════════════════════════════════════════════════════════════════════

describe('refineLazyCandidatesWithLLM (mocked API)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends correct IR to Cerebras and applies response', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'PaymentForm', source: './PaymentForm', prefetch: 'viewport', jsxPosition: 2 }),
      makeCandidate({ localName: 'PromoCode', source: './PromoCode', prefetch: 'interaction', conditional: true, jsxPosition: 0 }),
    ];
    const keepStatic = [
      { localName: 'CartProvider', source: './CartProvider', reason: 'Context provider' },
    ];

    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'PaymentForm', prefetch: 'idle', suspenseGroup: null, confidence: 0.92, reason: 'Has effects, preload on idle' },
        { name: 'PromoCode', prefetch: 'interaction', suspenseGroup: null, confidence: 0.88, reason: 'Conditional — confirmed interaction' },
      ],
      overrideToStatic: [],
      insights: ['PaymentForm has effects that need initialization time'],
    };

    fetchSpy.mockResolvedValueOnce(mockCerebrasResponse(llmResponse));

    const result = await refineLazyCandidatesWithLLM(
      candidates,
      keepStatic,
      '/app/pages/CheckoutPage.tsx',
      'CheckoutPage',
      undefined,
      'test-api-key',
      'qwen-3-32b',
    );

    // Verify fetch was called correctly
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect((options as RequestInit).method).toBe('POST');

    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-api-key');
    expect(headers['Content-Type']).toBe('application/json');

    // Verify the request body contains correct IR
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.model).toBe('qwen-3-32b');
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.response_format).toEqual({ type: 'json_object' });

    const ir = JSON.parse(body.messages[1].content);
    expect(ir.parent).toBe('CheckoutPage');
    expect(ir.file).toBe('/app/pages/CheckoutPage.tsx');
    expect(ir.candidates.length).toBe(2);
    expect(ir.candidates[0].name).toBe('PaymentForm');
    expect(ir.candidates[0].heuristicPrefetch).toBe('viewport');
    expect(ir.candidates[1].name).toBe('PromoCode');
    expect(ir.candidates[1].conditional).toBe(true);
    expect(ir.keptStatic.length).toBe(1);
    expect(ir.keptStatic[0].name).toBe('CartProvider');

    // Verify the merged result
    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0].prefetch).toBe('idle'); // LLM overrode viewport → idle
    expect(result.candidates[1].prefetch).toBe('interaction'); // LLM confirmed
    expect(result.insights).toContain('PaymentForm has effects that need initialization time');
    expect(result.movedToStatic.length).toBe(0);
  });

  it('includes component profiles in IR when available', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Dashboard', source: './Dashboard', prefetch: 'viewport' }),
    ];

    const profiles = new Map<string, ComponentProfile>([
      ['./Dashboard', {
        hasHandlers: true,
        hasState: true,
        hasEffects: true,
        handlerCount: 3,
        providesContext: false,
        estimatedSize: 15000,
      }],
    ]);

    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'Dashboard', prefetch: 'viewport', suspenseGroup: null, confidence: 0.9, reason: 'confirmed' },
      ],
      overrideToStatic: [],
      insights: [],
    };

    fetchSpy.mockResolvedValueOnce(mockCerebrasResponse(llmResponse));

    await refineLazyCandidatesWithLLM(
      candidates, [], '/app/App.tsx', 'App', profiles, 'test-key',
    );

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const ir = JSON.parse(body.messages[1].content);

    expect(ir.candidates[0].hasHandlers).toBe(true);
    expect(ir.candidates[0].hasState).toBe(true);
    expect(ir.candidates[0].hasEffects).toBe(true);
    expect(ir.candidates[0].handlerCount).toBe(3);
    expect(ir.candidates[0].estimatedSize).toBe(15000);
  });

  it('LLM can move candidates to static', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'TinyWidget', source: './TinyWidget', prefetch: 'viewport' }),
      makeCandidate({ localName: 'HeavyChart', source: './HeavyChart', prefetch: 'viewport' }),
    ];

    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'HeavyChart', prefetch: 'idle', suspenseGroup: null, confidence: 0.95, reason: 'large component, defer to idle' },
      ],
      overrideToStatic: [
        { name: 'TinyWidget', reason: 'Only 150 bytes, Suspense overhead exceeds savings' },
      ],
      insights: [],
    };

    fetchSpy.mockResolvedValueOnce(mockCerebrasResponse(llmResponse));

    const result = await refineLazyCandidatesWithLLM(
      candidates, [], '/app/App.tsx', 'App', undefined, 'test-key',
    );

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].localName).toBe('HeavyChart');
    expect(result.candidates[0].prefetch).toBe('idle');

    expect(result.movedToStatic.length).toBe(1);
    expect(result.movedToStatic[0].localName).toBe('TinyWidget');
    expect(result.movedToStatic[0].reason).toContain('LLM override');
  });

  it('uses custom model when specified', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Foo', source: './Foo' }),
    ];

    const llmResponse: LazyLLMResponse = {
      decisions: [{ name: 'Foo', prefetch: 'viewport', suspenseGroup: null, confidence: 0.9, reason: 'ok' }],
      overrideToStatic: [],
      insights: [],
    };

    fetchSpy.mockResolvedValueOnce(mockCerebrasResponse(llmResponse));

    await refineLazyCandidatesWithLLM(
      candidates, [], '/app/App.tsx', 'App', undefined, 'test-key', 'llama-4-scout-17b',
    );

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('llama-4-scout-17b');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. GRACEFUL DEGRADATION — API failure scenarios
// ══════════════════════════════════════════════════════════════════════════

describe('LLM graceful degradation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('returns original candidates on network failure', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'PaymentForm', source: './PaymentForm', prefetch: 'viewport' }),
    ];

    fetchSpy.mockRejectedValueOnce(new Error('Network error'));

    const result = await refineLazyCandidatesWithLLM(
      candidates, [], '/app/Page.tsx', 'Page', undefined, 'test-key',
    );

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].prefetch).toBe('viewport'); // unchanged
    expect(result.movedToStatic.length).toBe(0);
    expect(result.insights.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[phantom] LLM refinement failed'),
      expect.stringContaining('Network error'),
    );
  });

  it('returns original candidates on HTTP 500', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Chart', source: './Chart', prefetch: 'idle' }),
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    const result = await refineLazyCandidatesWithLLM(
      candidates, [], '/app/Page.tsx', 'Page', undefined, 'test-key',
    );

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].prefetch).toBe('idle'); // unchanged
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns original candidates on HTTP 401 (bad API key)', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Form', source: './Form', prefetch: 'viewport' }),
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    const result = await refineLazyCandidatesWithLLM(
      candidates, [], '/app/Page.tsx', 'Page', undefined, 'bad-key',
    );

    expect(result.candidates[0].prefetch).toBe('viewport');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[phantom] LLM refinement failed'),
      expect.stringContaining('401'),
    );
  });

  it('returns original candidates on malformed JSON response', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Widget', source: './Widget', prefetch: 'viewport' }),
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'not valid json {{{' } }],
      }), { status: 200 }),
    );

    const result = await refineLazyCandidatesWithLLM(
      candidates, [], '/app/Page.tsx', 'Page', undefined, 'test-key',
    );

    expect(result.candidates[0].prefetch).toBe('viewport');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns original candidates on missing decisions array', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Widget', source: './Widget', prefetch: 'viewport' }),
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ overrideToStatic: [], insights: [] }) } }],
      }), { status: 200 }),
    );

    const result = await refineLazyCandidatesWithLLM(
      candidates, [], '/app/Page.tsx', 'Page', undefined, 'test-key',
    );

    expect(result.candidates[0].prefetch).toBe('viewport');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[phantom] LLM refinement failed'),
      expect.stringContaining('missing decisions'),
    );
  });

  it('returns original candidates on empty choices array', async () => {
    const candidates: LazyCandidate[] = [
      makeCandidate({ localName: 'Widget', source: './Widget', prefetch: 'viewport' }),
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );

    const result = await refineLazyCandidatesWithLLM(
      candidates, [], '/app/Page.tsx', 'Page', undefined, 'test-key',
    );

    expect(result.candidates[0].prefetch).toBe('viewport');
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. END-TO-END: heuristic → LLM → AST transform
// ══════════════════════════════════════════════════════════════════════════

describe('full pipeline: detection → LLM refinement → AST transform', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('produces correct client code after LLM overrides Suspense grouping', async () => {
    const code = fixture('CheckoutPage.tsx');
    const parsed = parseModule(code, '/app/pages/CheckoutPage.tsx');
    const { classifyModule } = await import('../src/classify/index.js');
    const segments = classifyModule(parsed, code);

    // Step 1: Heuristic detection
    const heuristic = detectLazyCandidates(parsed, code, segments);

    expect(heuristic.lazy.length).toBeGreaterThanOrEqual(3);

    // Step 2: LLM refinement — override grouping
    // LLM says PromoCode should actually be 'idle' (not 'interaction') and
    // PaymentForm + AddressForm should share a group called 'checkout_forms'
    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'PaymentForm', prefetch: 'viewport', suspenseGroup: 'checkout_forms', confidence: 0.95, reason: 'Below fold, forms share validation state' },
        { name: 'AddressForm', prefetch: 'viewport', suspenseGroup: 'checkout_forms', confidence: 0.93, reason: 'Below fold, forms share validation state' },
        { name: 'PromoCode', prefetch: 'idle', suspenseGroup: null, confidence: 0.85, reason: 'Rarely used, preload when idle' },
        { name: 'OrderHistory', prefetch: 'interaction', suspenseGroup: null, confidence: 0.90, reason: 'User-triggered, confirmed interaction' },
      ],
      overrideToStatic: [],
      insights: [
        'PaymentForm and AddressForm share form validation context — group them.',
        'PromoCode is rarely used (analytics data suggests <5% of sessions).',
      ],
    };

    fetchSpy.mockResolvedValueOnce(mockCerebrasResponse(llmResponse));

    const refined = await refineLazyCandidatesWithLLM(
      heuristic.lazy,
      heuristic.keepStatic,
      '/app/pages/CheckoutPage.tsx',
      'CheckoutPage',
      undefined,
      'test-key',
    );

    // Verify LLM overrides were applied
    const pf = refined.candidates.find((c) => c.localName === 'PaymentForm')!;
    expect(pf.suspenseGroup).toBe('checkout_forms');

    const af = refined.candidates.find((c) => c.localName === 'AddressForm')!;
    expect(af.suspenseGroup).toBe('checkout_forms');

    const pc = refined.candidates.find((c) => c.localName === 'PromoCode')!;
    expect(pc.prefetch).toBe('idle');

    // Step 3: Apply AST transforms with LLM-refined candidates
    const clientAST = structuredClone(parsed.ast) as Program;
    applyLazyTransforms(clientAST, refined.candidates);

    // Verify the AST was transformed — check for lazy and Suspense imports
    const importDecls = clientAST.body.filter((n) => n.type === 'ImportDeclaration');
    const reactImport = importDecls.find(
      (n) => n.type === 'ImportDeclaration' && (n as any).source.value === 'react',
    ) as any;
    expect(reactImport).toBeDefined();

    const reactSpecifiers = reactImport.specifiers
      .filter((s: any) => s.type === 'ImportSpecifier')
      .map((s: any) => s.imported.name);
    expect(reactSpecifiers).toContain('lazy');
    expect(reactSpecifiers).toContain('Suspense');

    // Verify the static imports for lazified components were replaced with const declarations
    const varDecls = clientAST.body.filter((n) => n.type === 'VariableDeclaration');
    const lazyVarNames = varDecls
      .flatMap((v: any) => v.declarations)
      .filter((d: any) => d.init?.type === 'CallExpression' && d.init?.callee?.name === 'lazy')
      .map((d: any) => d.id.name);

    expect(lazyVarNames).toContain('PaymentForm');
    expect(lazyVarNames).toContain('AddressForm');
    expect(lazyVarNames).toContain('PromoCode');
    expect(lazyVarNames).toContain('OrderHistory');

    // Static imports should be preserved for kept-static components
    const staticImportSources = importDecls
      .filter((n: any) => n.source.value !== 'react' && n.source.value !== 'phantom-build/runtime')
      .map((n: any) => n.source.value);
    expect(staticImportSources).toContain('./CartProvider');
    expect(staticImportSources).toContain('./CartItems');
    expect(staticImportSources).toContain('./OrderSummary');
  });

  it('full pipeline with LLM override-to-static removes candidate from AST transforms', async () => {
    const code = fixture('CheckoutPage.tsx');
    const parsed = parseModule(code, '/app/pages/CheckoutPage.tsx');
    const { classifyModule } = await import('../src/classify/index.js');
    const segments = classifyModule(parsed, code);

    const heuristic = detectLazyCandidates(parsed, code, segments);

    // LLM says OrderHistory should actually be kept static
    const llmResponse: LazyLLMResponse = {
      decisions: [
        { name: 'PaymentForm', prefetch: 'viewport', suspenseGroup: null, confidence: 0.95, reason: 'confirmed' },
        { name: 'AddressForm', prefetch: 'viewport', suspenseGroup: null, confidence: 0.90, reason: 'confirmed' },
        { name: 'PromoCode', prefetch: 'interaction', suspenseGroup: null, confidence: 0.85, reason: 'confirmed' },
      ],
      overrideToStatic: [
        { name: 'OrderHistory', reason: 'Component only shows a cached list — trivial cost, not worth lazy loading' },
      ],
      insights: [],
    };

    fetchSpy.mockResolvedValueOnce(mockCerebrasResponse(llmResponse));

    const refined = await refineLazyCandidatesWithLLM(
      heuristic.lazy,
      heuristic.keepStatic,
      '/app/pages/CheckoutPage.tsx',
      'CheckoutPage',
      undefined,
      'test-key',
    );

    // OrderHistory should have been moved to static
    expect(refined.movedToStatic.length).toBe(1);
    expect(refined.movedToStatic[0].localName).toBe('OrderHistory');
    expect(refined.candidates.find((c) => c.localName === 'OrderHistory')).toBeUndefined();

    // Apply AST transforms — only 3 components should be lazified
    const clientAST = structuredClone(parsed.ast) as Program;
    applyLazyTransforms(clientAST, refined.candidates);

    const varDecls = clientAST.body.filter((n) => n.type === 'VariableDeclaration');
    const lazyVarNames = varDecls
      .flatMap((v: any) => v.declarations)
      .filter((d: any) => d.init?.type === 'CallExpression' && d.init?.callee?.name === 'lazy')
      .map((d: any) => d.id.name);

    expect(lazyVarNames).toContain('PaymentForm');
    expect(lazyVarNames).toContain('AddressForm');
    expect(lazyVarNames).toContain('PromoCode');
    expect(lazyVarNames).not.toContain('OrderHistory'); // LLM removed it
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. BATCHED LLM — multi-module IR building and merging
// ══════════════════════════════════════════════════════════════════════════

describe('batched LLM: IR building', () => {
  it('builds a BatchedLazyIR from multiple modules', () => {
    const moduleData = [
      {
        ir: {
          parent: 'CheckoutPage',
          file: '/app/pages/CheckoutPage.tsx',
          candidates: [
            { name: 'PaymentForm', source: './PaymentForm', jsxPosition: 2, conditional: false, hasHandlers: false, hasState: false, hasEffects: false, handlerCount: 0, estimatedSize: 0, heuristicPrefetch: 'viewport', heuristicReason: 'below fold' },
          ],
          keptStatic: [{ name: 'CartProvider', reason: 'Context provider' }],
          sharedState: [],
        },
      },
      {
        ir: {
          parent: 'DashboardPage',
          file: '/app/pages/DashboardPage.tsx',
          candidates: [
            { name: 'AnalyticsChart', source: './AnalyticsChart', jsxPosition: 3, conditional: false, hasHandlers: true, hasState: true, hasEffects: true, handlerCount: 2, estimatedSize: 12000, heuristicPrefetch: 'idle', heuristicReason: 'large component' },
            { name: 'RecentActivity', source: './RecentActivity', jsxPosition: 4, conditional: true, hasHandlers: false, hasState: false, hasEffects: false, handlerCount: 0, estimatedSize: 0, heuristicPrefetch: 'interaction', heuristicReason: 'conditional' },
          ],
          keptStatic: [],
          sharedState: [],
        },
      },
    ];

    const batched = buildBatchedIR(moduleData);

    expect(batched.modules.length).toBe(2);
    expect(batched.totalCandidates).toBe(3);
    expect(batched.modules[0].parent).toBe('CheckoutPage');
    expect(batched.modules[0].candidates.length).toBe(1);
    expect(batched.modules[1].parent).toBe('DashboardPage');
    expect(batched.modules[1].candidates.length).toBe(2);
  });
});

describe('batched LLM: mergeBatchedLLMDecisions', () => {
  it('merges a batched LLM response across multiple modules', () => {
    const moduleStash = new Map<string, { candidates: LazyCandidate[]; keepStatic: Array<{ localName: string; source: string; reason: string }> }>();

    moduleStash.set('/app/pages/CheckoutPage.tsx', {
      candidates: [
        makeCandidate({ localName: 'PaymentForm', source: './PaymentForm', prefetch: 'viewport' }),
      ],
      keepStatic: [],
    });

    moduleStash.set('/app/pages/DashboardPage.tsx', {
      candidates: [
        makeCandidate({ localName: 'AnalyticsChart', source: './AnalyticsChart', prefetch: 'idle' }),
        makeCandidate({ localName: 'RecentActivity', source: './RecentActivity', prefetch: 'interaction', conditional: true }),
      ],
      keepStatic: [],
    });

    const batchedResponse: BatchedLazyLLMResponse = {
      modules: {
        '/app/pages/CheckoutPage.tsx': {
          decisions: [
            { name: 'PaymentForm', prefetch: 'immediate', suspenseGroup: null, confidence: 0.95, reason: 'critical path' },
          ],
          overrideToStatic: [],
          insights: ['PaymentForm is on the critical checkout path'],
        },
        '/app/pages/DashboardPage.tsx': {
          decisions: [
            { name: 'AnalyticsChart', prefetch: 'idle', suspenseGroup: 'analytics', confidence: 0.90, reason: 'heavy, defer' },
            { name: 'RecentActivity', prefetch: 'interaction', suspenseGroup: null, confidence: 0.85, reason: 'user-triggered' },
          ],
          overrideToStatic: [],
          insights: [],
        },
      },
      globalInsights: ['PaymentForm from Checkout and AnalyticsChart from Dashboard share a data service import'],
    };

    const results = mergeBatchedLLMDecisions(moduleStash, batchedResponse, 0.8);

    expect(results.size).toBe(2);

    // Checkout module
    const checkoutResult = results.get('/app/pages/CheckoutPage.tsx')!;
    expect(checkoutResult.updated.length).toBe(1);
    expect(checkoutResult.updated[0].prefetch).toBe('immediate');
    expect(checkoutResult.updated[0].reason).toContain('LLM');
    expect(checkoutResult.insights).toContain('PaymentForm is on the critical checkout path');

    // Dashboard module
    const dashboardResult = results.get('/app/pages/DashboardPage.tsx')!;
    expect(dashboardResult.updated.length).toBe(2);
    expect(dashboardResult.updated[0].suspenseGroup).toBe('analytics');
  });

  it('preserves heuristic decisions for modules not in LLM response', () => {
    const moduleStash = new Map<string, { candidates: LazyCandidate[]; keepStatic: Array<{ localName: string; source: string; reason: string }> }>();

    moduleStash.set('/app/pages/Orphan.tsx', {
      candidates: [
        makeCandidate({ localName: 'Widget', source: './Widget', prefetch: 'viewport', reason: 'heuristic: below fold' }),
      ],
      keepStatic: [],
    });

    const batchedResponse: BatchedLazyLLMResponse = {
      modules: {}, // LLM returned no data for this module
      globalInsights: [],
    };

    const results = mergeBatchedLLMDecisions(moduleStash, batchedResponse, 0.8);

    expect(results.size).toBe(1);
    const orphanResult = results.get('/app/pages/Orphan.tsx')!;
    expect(orphanResult.updated.length).toBe(1);
    expect(orphanResult.updated[0].prefetch).toBe('viewport');
    expect(orphanResult.updated[0].reason).toBe('heuristic: below fold');
  });

  it('handles LLM moving candidates to static in batched mode', () => {
    const moduleStash = new Map<string, { candidates: LazyCandidate[]; keepStatic: Array<{ localName: string; source: string; reason: string }> }>();

    moduleStash.set('/app/Layout.tsx', {
      candidates: [
        makeCandidate({ localName: 'TinyIcon', source: './TinyIcon', prefetch: 'viewport' }),
        makeCandidate({ localName: 'HeavyPanel', source: './HeavyPanel', prefetch: 'idle' }),
      ],
      keepStatic: [],
    });

    const batchedResponse: BatchedLazyLLMResponse = {
      modules: {
        '/app/Layout.tsx': {
          decisions: [
            { name: 'HeavyPanel', prefetch: 'idle', suspenseGroup: null, confidence: 0.92, reason: 'confirmed idle' },
          ],
          overrideToStatic: [
            { name: 'TinyIcon', reason: 'Only 100 bytes — not worth the boundary' },
          ],
          insights: [],
        },
      },
      globalInsights: [],
    };

    const results = mergeBatchedLLMDecisions(moduleStash, batchedResponse, 0.8);
    const layoutResult = results.get('/app/Layout.tsx')!;

    expect(layoutResult.updated.length).toBe(1);
    expect(layoutResult.updated[0].localName).toBe('HeavyPanel');
    expect(layoutResult.movedToStatic.length).toBe(1);
    expect(layoutResult.movedToStatic[0].localName).toBe('TinyIcon');
    expect(layoutResult.movedToStatic[0].reason).toContain('LLM override');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. BATCHED LLM CLIENT — refineLazyCandidatesBatched (mocked API)
// ══════════════════════════════════════════════════════════════════════════

describe('refineLazyCandidatesBatched (mocked API)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** Build a mock Cerebras API response for a batched response */
  function mockBatchedCerebrasResponse(batchedResponse: BatchedLazyLLMResponse): Response {
    return new Response(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(batchedResponse),
          },
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('sends a single batched API request for multiple modules', async () => {
    const moduleStash = new Map<string, {
      candidates: LazyCandidate[];
      keepStatic: Array<{ localName: string; source: string; reason: string }>;
      parentComponent: string;
      componentProfiles: Map<string, ComponentProfile> | undefined;
    }>();

    moduleStash.set('/app/pages/Checkout.tsx', {
      candidates: [makeCandidate({ localName: 'PaymentForm', source: './PaymentForm' })],
      keepStatic: [{ localName: 'CartProvider', source: './CartProvider', reason: 'Context provider' }],
      parentComponent: 'Checkout',
      componentProfiles: undefined,
    });

    moduleStash.set('/app/pages/Dashboard.tsx', {
      candidates: [
        makeCandidate({ localName: 'Chart', source: './Chart', prefetch: 'idle' }),
        makeCandidate({ localName: 'Feed', source: './Feed', prefetch: 'interaction', conditional: true }),
      ],
      keepStatic: [],
      parentComponent: 'Dashboard',
      componentProfiles: undefined,
    });

    const batchedResponse: BatchedLazyLLMResponse = {
      modules: {
        '/app/pages/Checkout.tsx': {
          decisions: [
            { name: 'PaymentForm', prefetch: 'immediate', suspenseGroup: null, confidence: 0.95, reason: 'critical path' },
          ],
          overrideToStatic: [],
          insights: [],
        },
        '/app/pages/Dashboard.tsx': {
          decisions: [
            { name: 'Chart', prefetch: 'idle', suspenseGroup: 'dashboard_viz', confidence: 0.92, reason: 'grouped with Feed' },
            { name: 'Feed', prefetch: 'interaction', suspenseGroup: null, confidence: 0.88, reason: 'conditional confirmed' },
          ],
          overrideToStatic: [],
          insights: ['Chart and Feed could share a data context'],
        },
      },
      globalInsights: ['Both modules share a user context provider — consider coordination'],
    };

    fetchSpy.mockResolvedValueOnce(mockBatchedCerebrasResponse(batchedResponse));

    const { results, globalInsights } = await refineLazyCandidatesBatched(
      moduleStash,
      'test-batch-key',
      'qwen-3-32b',
      0.8,
    );

    // Should have been called exactly once (single batched request)
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Verify the request
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(CEREBRAS_API_URL);
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.messages[0].role).toBe('system');
    // Batched prompt should mention "MULTIPLE modules"
    expect(body.messages[0].content).toContain('MULTIPLE modules');

    const ir = JSON.parse(body.messages[1].content);
    expect(ir.modules.length).toBe(2);
    expect(ir.totalCandidates).toBe(3);
    expect(ir.modules[0].parent).toBe('Checkout');
    expect(ir.modules[1].parent).toBe('Dashboard');

    // Verify merged results
    expect(results.size).toBe(2);

    const checkoutResult = results.get('/app/pages/Checkout.tsx')!;
    expect(checkoutResult.updated[0].prefetch).toBe('immediate');

    const dashboardResult = results.get('/app/pages/Dashboard.tsx')!;
    expect(dashboardResult.updated[0].suspenseGroup).toBe('dashboard_viz');

    expect(globalInsights).toContain('Both modules share a user context provider — consider coordination');
  });

  it('scales max_tokens based on module count', async () => {
    const moduleStash = new Map<string, {
      candidates: LazyCandidate[];
      keepStatic: Array<{ localName: string; source: string; reason: string }>;
      parentComponent: string;
      componentProfiles: Map<string, ComponentProfile> | undefined;
    }>();

    // Add 5 modules
    for (let i = 0; i < 5; i++) {
      moduleStash.set(`/app/pages/Page${i}.tsx`, {
        candidates: [makeCandidate({ localName: `Component${i}`, source: `./Component${i}` })],
        keepStatic: [],
        parentComponent: `Page${i}`,
        componentProfiles: undefined,
      });
    }

    const batchedResponse: BatchedLazyLLMResponse = {
      modules: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `/app/pages/Page${i}.tsx`,
          {
            decisions: [{ name: `Component${i}`, prefetch: 'viewport' as const, suspenseGroup: null, confidence: 0.9, reason: 'ok' }],
            overrideToStatic: [],
            insights: [],
          },
        ]),
      ),
      globalInsights: [],
    };

    fetchSpy.mockResolvedValueOnce(mockBatchedCerebrasResponse(batchedResponse));

    await refineLazyCandidatesBatched(moduleStash, 'test-key');

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    // 1024 + 5 * 512 = 3584
    expect(body.max_tokens).toBe(3584);
  });

  it('falls back to heuristics for all modules on API failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const moduleStash = new Map<string, {
      candidates: LazyCandidate[];
      keepStatic: Array<{ localName: string; source: string; reason: string }>;
      parentComponent: string;
      componentProfiles: Map<string, ComponentProfile> | undefined;
    }>();

    moduleStash.set('/app/Page.tsx', {
      candidates: [
        makeCandidate({ localName: 'Widget', source: './Widget', prefetch: 'viewport', reason: 'heuristic' }),
      ],
      keepStatic: [],
      parentComponent: 'Page',
      componentProfiles: undefined,
    });

    moduleStash.set('/app/Layout.tsx', {
      candidates: [
        makeCandidate({ localName: 'Sidebar', source: './Sidebar', prefetch: 'idle', reason: 'heuristic' }),
      ],
      keepStatic: [],
      parentComponent: 'Layout',
      componentProfiles: undefined,
    });

    fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));

    const { results, globalInsights } = await refineLazyCandidatesBatched(
      moduleStash, 'test-key',
    );

    // All modules should have their original candidates preserved
    expect(results.size).toBe(2);

    const pageResult = results.get('/app/Page.tsx')!;
    expect(pageResult.updated[0].prefetch).toBe('viewport');
    expect(pageResult.updated[0].reason).toBe('heuristic');
    expect(pageResult.movedToStatic.length).toBe(0);

    const layoutResult = results.get('/app/Layout.tsx')!;
    expect(layoutResult.updated[0].prefetch).toBe('idle');

    expect(globalInsights.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[phantom] Batched LLM refinement failed'),
      expect.stringContaining('Connection refused'),
    );

    warnSpy.mockRestore();
  });

  it('falls back to heuristics on invalid batched response structure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const moduleStash = new Map<string, {
      candidates: LazyCandidate[];
      keepStatic: Array<{ localName: string; source: string; reason: string }>;
      parentComponent: string;
      componentProfiles: Map<string, ComponentProfile> | undefined;
    }>();

    moduleStash.set('/app/Page.tsx', {
      candidates: [makeCandidate({ localName: 'Widget', source: './Widget', prefetch: 'viewport' })],
      keepStatic: [],
      parentComponent: 'Page',
      componentProfiles: undefined,
    });

    // Return a response missing the "modules" key
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ decisions: [], insights: [] }) } }],
      }), { status: 200 }),
    );

    const { results } = await refineLazyCandidatesBatched(moduleStash, 'test-key');

    expect(results.size).toBe(1);
    expect(results.get('/app/Page.tsx')!.updated[0].prefetch).toBe('viewport');
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
