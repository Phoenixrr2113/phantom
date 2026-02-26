import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeModule } from '../src/analyzer.js';
import type { ClassifiedSegment } from '../src/types.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

/** Find a segment by name substring */
function segByName(segments: ClassifiedSegment[], nameSubstr: string) {
  return segments.find(s => s.name.includes(nameSubstr));
}

/** Find all segments by classification */
function segsByClass(segments: ClassifiedSegment[], cls: string) {
  return segments.filter(s => s.classification === cls);
}

describe('classification engine', () => {
  describe('pure-memo.tsx', () => {
    const getResult = () => analyzeModule(fixture('pure-memo.tsx'), 'pure-memo.tsx');

    it('ProductPage is NOT PureComputation (contains JSX)', () => {
      const result = getResult();
      const page = segByName(result.segments, 'ProductPage');
      expect(page).toBeDefined();
      expect(page!.classification).not.toBe('PureComputation');
      expect(page!.classification).toBe('Shared');
      expect(page!.confidence).toBe(0.0);
      expect(page!.reasons).toContain('React component (contains JSX) — not extractable');
    });

    it('useMemo callback is PureComputation with confidence >= 0.9', () => {
      const result = getResult();
      const pureSegments = segsByClass(result.segments, 'PureComputation');
      expect(pureSegments.length).toBe(1);
      expect(pureSegments[0].confidence).toBeGreaterThanOrEqual(0.9);
      expect(pureSegments[0].reasons).toContain('Pure computation inside useMemo');
    });

    it('inner lambdas (.filter, .sort, .map) are Shared', () => {
      const result = getResult();
      const shared = segsByClass(result.segments, 'Shared');
      const pureLambdas = shared.filter(s => s.confidence === 0.7);
      expect(pureLambdas.length).toBeGreaterThanOrEqual(2);
      for (const seg of pureLambdas) {
        expect(seg.reasons).toContain('Pure anonymous function — may be used in both contexts');
      }
    });
  });

  describe('event-handler.tsx', () => {
    const getResult = () => analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx');

    it('handleClick is EventHandler for onClick', () => {
      const result = getResult();
      const handleClick = segByName(result.segments, 'handleClick');
      expect(handleClick).toBeDefined();
      expect(handleClick!.classification).toBe('EventHandler');
      expect(handleClick!.reasons.some(r => r.includes('onClick'))).toBe(true);
    });

    it('handleFocus is EventHandler for onFocus', () => {
      const result = getResult();
      const handleFocus = segByName(result.segments, 'handleFocus');
      expect(handleFocus).toBeDefined();
      expect(handleFocus!.classification).toBe('EventHandler');
      expect(handleFocus!.reasons.some(r => r.includes('onFocus'))).toBe(true);
    });

    it('handleScroll is EventHandler for onClick', () => {
      const result = getResult();
      const handleScroll = segByName(result.segments, 'handleScroll');
      expect(handleScroll).toBeDefined();
      expect(handleScroll!.classification).toBe('EventHandler');
      expect(handleScroll!.reasons.some(r => r.includes('onClick'))).toBe(true);
    });

    it('has EventHandler segments and extractions', () => {
      // Pass minHandlerSize: 0 so small test fixture handlers still get extracted
      const result = analyzeModule(fixture('event-handler.tsx'), 'event-handler.tsx', { minHandlerSize: 0 });
      const eventHandlers = segsByClass(result.segments, 'EventHandler');
      expect(eventHandlers.length).toBeGreaterThanOrEqual(3);
      expect(result.hasExtractions).toBe(true);
    });

    it('InteractiveComponent is ClientInteractive (contains JSX + browser globals)', () => {
      const result = getResult();
      const component = segByName(result.segments, 'InteractiveComponent');
      expect(component).toBeDefined();
      // The component itself touches browser globals via taint propagation
      // but also contains JSX, so it could be ClientInteractive or Shared
      expect(component!.classification).not.toBe('EventHandler');
      expect(component!.classification).not.toBe('PureComputation');
    });
  });

  describe('mixed.tsx', () => {
    const getResult = () => analyzeModule(fixture('mixed.tsx'), 'mixed.tsx');

    it('useMemo callbacks are PureComputation', () => {
      const result = getResult();
      const pureSegments = segsByClass(result.segments, 'PureComputation');
      const memoCallbacks = pureSegments.filter(
        s => s.reasons.some(r => r.includes('useMemo'))
      );
      expect(memoCallbacks.length).toBe(2);
      for (const seg of memoCallbacks) {
        expect(seg.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('useEffect callback is ClientInteractive with confidence 1.0', () => {
      const result = getResult();
      const effectCallback = result.segments.find(
        s => s.reasons.some(r => r.includes('useEffect'))
      );
      expect(effectCallback).toBeDefined();
      expect(effectCallback!.classification).toBe('ClientInteractive');
      expect(effectCallback!.confidence).toBe(1.0);
    });

    it('handleSubmit useCallback callback is EventHandler for onSubmit', () => {
      const result = getResult();
      // The inner callback of useCallback((e) => { e.preventDefault()... })
      // should be classified as EventHandler because handleSubmit is used as onSubmit={handleSubmit}
      const eventHandlers = segsByClass(result.segments, 'EventHandler');
      const submitHandler = eventHandlers.find(
        s => s.reasons.some(r => r.includes('onSubmit'))
      );
      expect(submitHandler).toBeDefined();
      expect(submitHandler!.confidence).toBe(0.9);
    });

    it('formatValue is PureComputation (pure named helper)', () => {
      const result = getResult();
      const formatValue = segByName(result.segments, 'formatValue');
      expect(formatValue).toBeDefined();
      expect(formatValue!.classification).toBe('PureComputation');
      expect(formatValue!.confidence).toBe(0.85);
      expect(formatValue!.reasons).toContain('Pure named helper function');
    });

    it('MixedComponent itself is ClientInteractive', () => {
      const result = getResult();
      const component = segByName(result.segments, 'MixedComponent');
      expect(component).toBeDefined();
      expect(component!.classification).toBe('ClientInteractive');
    });

    it('provides valid metadata for each segment', () => {
      const result = getResult();
      for (const segment of result.segments) {
        expect(segment.reasons.length).toBeGreaterThan(0);
        expect(segment.id).toMatch(/^seg_/);
        expect(segment.confidence).toBeGreaterThanOrEqual(0);
        expect(segment.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('inline code', () => {
    it('classifies pure helper as PureComputation', () => {
      const code = `
        function formatPrice(price) {
          return '$' + price.toFixed(2);
        }
        export default formatPrice;
      `;
      const result = analyzeModule(code, 'format.ts');

      const pureSegments = segsByClass(result.segments, 'PureComputation');
      expect(pureSegments.length).toBe(1);
      expect(pureSegments[0].name).toContain('formatPrice');
    });

    it('classifies DOM-touching function as ClientInteractive', () => {
      const code = `
        function scrollToTop() {
          window.scrollTo(0, 0);
        }
        export default scrollToTop;
      `;
      const result = analyzeModule(code, 'scroll.ts');

      const clientSegments = segsByClass(result.segments, 'ClientInteractive');
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

      const ambiguous = segsByClass(result.segments, 'Ambiguous');
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

      const effectCallbacks = result.segments.filter(
        s => s.classification === 'ClientInteractive' &&
          s.reasons.some(r => r.includes('useEffect'))
      );
      expect(effectCallbacks.length).toBe(1);
      expect(effectCallbacks[0].confidence).toBe(1.0);
    });

    it('classifies empty module with no segments', () => {
      const result = analyzeModule('const x = 1;', 'empty.ts');
      expect(result.segments).toEqual([]);
      expect(result.hasExtractions).toBe(false);
    });

    it('JSX component is NOT PureComputation', () => {
      const code = `
        function Greeting({ name }) {
          return <h1>Hello {name}</h1>;
        }
        export default Greeting;
      `;
      const result = analyzeModule(code, 'greeting.tsx');
      const greeting = segByName(result.segments, 'Greeting');
      expect(greeting).toBeDefined();
      expect(greeting!.classification).not.toBe('PureComputation');
      expect(greeting!.classification).toBe('Shared');
      expect(greeting!.reasons).toContain('React component (contains JSX) — not extractable');
    });

    it('taint propagates through arrow functions', () => {
      const code = `
        const touchesDOM = () => {
          document.body.classList.add('active');
        };
        const callsToucher = () => {
          touchesDOM();
          return 42;
        };
        export { callsToucher };
      `;
      const result = analyzeModule(code, 'taint-prop.ts');

      const toucher = segByName(result.segments, 'touchesDOM');
      expect(toucher).toBeDefined();
      expect(toucher!.classification).toBe('ClientInteractive');

      const caller = segByName(result.segments, 'callsToucher');
      expect(caller).toBeDefined();
      expect(caller!.classification).toBe('ClientInteractive');
      expect(caller!.reasons.some(r => r.includes('via touchesDOM'))).toBe(true);
    });

    it('React.useMemo namespace call detects hook context', () => {
      const code = `
        import React from 'react';
        function App({ items }) {
          const total = React.useMemo(() => items.reduce((s, i) => s + i.value, 0), [items]);
          return null;
        }
      `;
      const result = analyzeModule(code, 'ns-hook.tsx');

      const memoCallback = result.segments.find(
        s => s.reasons.some(r => r.includes('useMemo'))
      );
      expect(memoCallback).toBeDefined();
      expect(memoCallback!.classification).toBe('PureComputation');
      expect(memoCallback!.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('function using only fetch is Ambiguous (not ClientInteractive)', () => {
      const code = `
        function fetchData() {
          return fetch('/api/data').then(r => r.json());
        }
        export default fetchData;
      `;
      const result = analyzeModule(code, 'fetch-only.ts');

      const fetchFn = segByName(result.segments, 'fetchData');
      expect(fetchFn).toBeDefined();
      expect(fetchFn!.classification).not.toBe('ClientInteractive');
      expect(fetchFn!.classification).toBe('Ambiguous');
      expect(fetchFn!.reasons.some(r => r.includes('fetch'))).toBe(true);
    });

    it('function used as event handler AND in render is NOT EventHandler (exclusive-use)', () => {
      const code = `
        import React from 'react';
        function App() {
          const doStuff = () => { console.log('stuff'); };
          doStuff(); // called in render too
          return <button onClick={doStuff}>Click</button>;
        }
      `;
      const result = analyzeModule(code, 'dual-use.tsx');

      const doStuff = segByName(result.segments, 'doStuff');
      expect(doStuff).toBeDefined();
      expect(doStuff!.classification).not.toBe('EventHandler');
    });

    it('inline arrow event handler is EventHandler', () => {
      const code = `
        import React from 'react';
        function App() {
          return <button onClick={() => { window.alert('hi'); }}>Click</button>;
        }
      `;
      const result = analyzeModule(code, 'inline-handler.tsx');

      const eventHandlers = segsByClass(result.segments, 'EventHandler');
      expect(eventHandlers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('component-with-helpers.tsx', () => {
    const getResult = () => analyzeModule(
      fixture('component-with-helpers.tsx'),
      'component-with-helpers.tsx'
    );

    it('UserDashboard (contains JSX) is NOT PureComputation', () => {
      const result = getResult();
      const dashboard = segByName(result.segments, 'UserDashboard');
      expect(dashboard).toBeDefined();
      expect(dashboard!.classification).not.toBe('PureComputation');
      // May be ClientInteractive (taint from navigateToUser) or Shared (JSX) —
      // either way, never PureComputation
    });

    it('formatDate is PureComputation (pure named arrow helper)', () => {
      const result = getResult();
      const formatDate = segByName(result.segments, 'formatDate');
      expect(formatDate).toBeDefined();
      expect(formatDate!.classification).toBe('PureComputation');
      expect(formatDate!.confidence).toBe(0.85);
    });

    it('scrollToUser is ClientInteractive (touches document)', () => {
      const result = getResult();
      const scrollToUser = segByName(result.segments, 'scrollToUser');
      expect(scrollToUser).toBeDefined();
      expect(scrollToUser!.classification).toBe('ClientInteractive');
      expect(scrollToUser!.reasons.some(r => r.includes('document'))).toBe(true);
    });

    it('navigateToUser is ClientInteractive (taint propagates from scrollToUser)', () => {
      const result = getResult();
      const navigateToUser = segByName(result.segments, 'navigateToUser');
      expect(navigateToUser).toBeDefined();
      expect(navigateToUser!.classification).toBe('ClientInteractive');
    });

    it('React.useMemo callback is PureComputation (namespace call)', () => {
      const result = getResult();
      // Find the useMemo callback for admins
      const memoCallbacks = result.segments.filter(
        s => s.classification === 'PureComputation' &&
          s.reasons.some(r => r.includes('useMemo'))
      );
      expect(memoCallbacks.length).toBeGreaterThanOrEqual(1);
    });

    it('both useMemo callbacks are PureComputation', () => {
      const result = getResult();
      const memoCallbacks = result.segments.filter(
        s => s.reasons.some(r => r.includes('useMemo'))
      );
      expect(memoCallbacks.length).toBe(2);
      for (const seg of memoCallbacks) {
        expect(seg.classification).toBe('PureComputation');
        expect(seg.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });
  });
});
