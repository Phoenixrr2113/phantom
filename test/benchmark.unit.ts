import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeModule } from '../src/index.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

// ── Performance benchmarks ──────────────────────────────────────────────

describe('performance benchmarks', () => {
  const FIXTURES = ['event-handler.tsx', 'mixed.tsx', 'pure-memo.tsx', 'component-with-helpers.tsx'];

  describe('analyzeModule speed', () => {
    for (const name of FIXTURES) {
      it(`${name} completes in under 100ms`, () => {
        const code = fixture(name);
        const iterations = 10;
        const times: number[] = [];

        // Warm up (JIT)
        analyzeModule(code, name, { minHandlerSize: 0 });

        for (let i = 0; i < iterations; i++) {
          const start = performance.now();
          analyzeModule(code, name, { minHandlerSize: 0 });
          times.push(performance.now() - start);
        }

        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const max = Math.max(...times);

        // Report timing
        console.log(`  [bench] ${name}: avg=${avg.toFixed(2)}ms, max=${max.toFixed(2)}ms`);

        // Assert: each individual run must be under 100ms
        expect(max).toBeLessThan(100);
      });
    }
  });

  describe('chunk sizes', () => {
    it('reports chunk sizes for event-handler.tsx extraction', () => {
      const code = fixture('event-handler.tsx');
      const result = analyzeModule(code, 'event-handler.tsx', { minHandlerSize: 0 });

      expect(result.hasExtractions).toBe(true);
      expect(result.chunkModules).toBeDefined();
      expect(result.chunkModules!.length).toBeGreaterThan(0);

      const sizes: { id: string; bytes: number }[] = [];
      for (const chunk of result.chunkModules!) {
        const bytes = Buffer.byteLength(chunk.code, 'utf-8');
        sizes.push({ id: chunk.id, bytes });
      }

      console.log('  [bench] Chunk sizes:');
      for (const { id, bytes } of sizes) {
        console.log(`    ${id}: ${bytes} bytes`);
      }

      // Sanity: each chunk should be small (under 2KB for test fixtures)
      for (const { bytes } of sizes) {
        expect(bytes).toBeLessThan(2048);
      }
    });

    it('handler logic moves from client to chunks', () => {
      const code = fixture('event-handler.tsx');
      const result = analyzeModule(code, 'event-handler.tsx', { minHandlerSize: 0 });

      expect(result.clientCode).toBeDefined();
      const originalBytes = Buffer.byteLength(code, 'utf-8');
      const clientBytes = Buffer.byteLength(result.clientCode!, 'utf-8');
      const totalChunkBytes = result.chunkModules!.reduce(
        (sum, c) => sum + Buffer.byteLength(c.code, 'utf-8'),
        0,
      );

      console.log(`  [bench] Original: ${originalBytes}B → Client: ${clientBytes}B + Chunks: ${totalChunkBytes}B`);

      // Handler logic should be in chunks, not in client code
      expect(totalChunkBytes).toBeGreaterThan(0);
      // Client code should NOT contain the handler bodies
      expect(result.clientCode).not.toContain('window.alert');
      expect(result.clientCode).toContain('$p');
    });
  });

  describe('deterministic output', () => {
    it('segment IDs are deterministic across repeated runs', () => {
      const code = fixture('event-handler.tsx');

      const result1 = analyzeModule(code, 'event-handler.tsx', { minHandlerSize: 0 });
      const result2 = analyzeModule(code, 'event-handler.tsx', { minHandlerSize: 0 });

      expect(result1.chunkModules!.length).toBe(result2.chunkModules!.length);

      for (let i = 0; i < result1.chunkModules!.length; i++) {
        expect(result1.chunkModules![i].id).toBe(result2.chunkModules![i].id);
        expect(result1.chunkModules![i].code).toBe(result2.chunkModules![i].code);
      }
    });

    it('client code is identical across repeated runs', () => {
      const code = fixture('mixed.tsx');

      const result1 = analyzeModule(code, 'mixed.tsx', { minHandlerSize: 0 });
      const result2 = analyzeModule(code, 'mixed.tsx', { minHandlerSize: 0 });

      expect(result1.clientCode).toBe(result2.clientCode);
    });

    it('segment IDs are content-based (same code → same IDs regardless of path)', () => {
      const code = fixture('event-handler.tsx');

      const result1 = analyzeModule(code, '/src/App.tsx', { minHandlerSize: 0 });
      const result2 = analyzeModule(code, '/src/Other.tsx', { minHandlerSize: 0 });

      // Group IDs are path-based, so they will differ
      expect(result1.chunkModules!.length).toBe(result2.chunkModules!.length);

      // But individual segment IDs are content-hashed, so same code produces same IDs
      const segIds1 = result1.extractedSegmentIds!.sort();
      const segIds2 = result2.extractedSegmentIds!.sort();
      expect(segIds1).toEqual(segIds2);
    });
  });
});
