import { describe, it, expect } from 'vitest';
import { analyzeModule } from '../src/analyzer.js';

describe('phantom smoke test', () => {
  it('analyzeModule returns a result with no extractions for simple code', () => {
    const result = analyzeModule('const x = 1;', 'test.ts');

    expect(result).toEqual({
      path: 'test.ts',
      segments: [],
      hasServerExtractions: false,
    });
  });

  it('types are properly exported', async () => {
    const mod = await import('../src/index.js');
    expect(mod.analyzeModule).toBeTypeOf('function');
    expect(mod.phantom).toBeDefined();
  });
});
