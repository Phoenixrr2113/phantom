import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeModule } from '../src/analyzer.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

describe('classification engine', () => {
  describe('pure-memo.tsx', () => {
    it('classifies useMemo callback as ServerCompute', () => {
      const result = analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      // Should find at least one ServerCompute segment
      const serverSegments = result.segments.filter(
        s => s.classification === 'ServerCompute'
      );
      expect(serverSegments.length).toBeGreaterThan(0);
      expect(result.hasServerExtractions).toBe(true);
    });

    it('ServerCompute segments have high confidence', () => {
      const result = analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

      const serverSegments = result.segments.filter(
        s => s.classification === 'ServerCompute'
      );
      for (const seg of serverSegments) {
        expect(seg.confidence).toBeGreaterThanOrEqual(0.8);
      }
    });
  });

  describe('event-handler.tsx', () => {
    it('classifies event handlers as ClientInteractive', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');

      const clientSegments = result.segments.filter(
        s => s.classification === 'ClientInteractive'
      );
      expect(clientSegments.length).toBeGreaterThan(0);

      // Check that browser globals are mentioned in reasons
      const windowRef = clientSegments.find(
        s => s.reasons.some(r => r.includes('window'))
      );
      expect(windowRef).toBeDefined();
    });

    it('has no ServerCompute segments', () => {
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');

      const serverSegments = result.segments.filter(
        s => s.classification === 'ServerCompute'
      );
      expect(serverSegments).toEqual([]);
      expect(result.hasServerExtractions).toBe(false);
    });
  });

  describe('mixed.tsx', () => {
    it('finds both ServerCompute and ClientInteractive segments', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');

      const serverSegments = result.segments.filter(
        s => s.classification === 'ServerCompute'
      );
      const clientSegments = result.segments.filter(
        s => s.classification === 'ClientInteractive'
      );

      expect(serverSegments.length).toBeGreaterThan(0);
      expect(clientSegments.length).toBeGreaterThan(0);
    });

    it('provides reasons for each classification', () => {
      const result = analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');

      for (const segment of result.segments) {
        expect(segment.reasons.length).toBeGreaterThan(0);
        expect(segment.id).toMatch(/^seg_/);
        expect(segment.confidence).toBeGreaterThanOrEqual(0);
        expect(segment.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('inline code', () => {
    it('classifies pure helper as ServerCompute', () => {
      const code = `
        function formatPrice(price) {
          return '$' + price.toFixed(2);
        }
        export default formatPrice;
      `;
      const result = analyzeModule(code, 'format.ts');

      const serverSegments = result.segments.filter(
        s => s.classification === 'ServerCompute'
      );
      expect(serverSegments.length).toBe(1);
      expect(serverSegments[0].name).toContain('formatPrice');
    });

    it('classifies DOM-touching function as ClientInteractive', () => {
      const code = `
        function scrollToTop() {
          window.scrollTo(0, 0);
        }
        export default scrollToTop;
      `;
      const result = analyzeModule(code, 'scroll.ts');

      const clientSegments = result.segments.filter(
        s => s.classification === 'ClientInteractive'
      );
      expect(clientSegments.length).toBe(1);
      expect(clientSegments[0].reasons.some(r => r.includes('window'))).toBe(true);
    });

    it('classifies function with unknown globals as Ambiguous', () => {
      const code = `
        function doSomething() {
          return someUnknownGlobal.process();
        }
      `;
      const result = analyzeModule(code, 'unknown.ts');

      const ambiguous = result.segments.filter(
        s => s.classification === 'Ambiguous'
      );
      expect(ambiguous.length).toBe(1);
    });

    it('classifies useEffect callback as ClientInteractive', () => {
      const code = `
        import { useEffect } from 'react';
        function App() {
          useEffect(() => {
            const x = 1;
          }, []);
          return null;
        }
      `;
      const result = analyzeModule(code, 'effect.tsx');

      // The useEffect callback should be client (even though its body is pure)
      const clientSegments = result.segments.filter(
        s => s.classification === 'ClientInteractive'
      );
      expect(clientSegments.length).toBeGreaterThan(0);
    });

    it('classifies empty module with no segments', () => {
      const result = analyzeModule('const x = 1;', 'empty.ts');
      expect(result.segments).toEqual([]);
      expect(result.hasServerExtractions).toBe(false);
    });
  });
});
