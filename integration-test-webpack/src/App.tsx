import React, { useState, useCallback, useMemo } from 'react';
import { formatCurrency } from './utils';

/**
 * Integration test component exercising all Phantom extraction patterns:
 *
 * 1. handleClick — arrow function event handler (should be extracted)
 * 2. handleSubmit — useCallback + preventDefault (should be extracted with sync prelude)
 * 3. handleScroll — arrow function, window API (should be extracted)
 * 4. useMemo callback — PureComputation (should NOT be extracted, stays in bundle)
 * 5. useEffect — ClientInteractive (should NOT be extracted)
 * 6. formatCurrency — imported helper used in handler (tests import rewriting in chunks)
 */
export function App() {
  const [count, setCount] = useState(0);
  const [items] = useState([
    { id: '1', name: 'Widget', price: 9.99 },
    { id: '2', name: 'Gadget', price: 24.95 },
    { id: '3', name: 'Doohickey', price: 3.50 },
  ]);

  // Event handler — should be extracted to a lazy chunk
  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    window.alert(`Clicked on ${target.tagName}`);
    setCount((c) => c + 1);
  };

  // useCallback + preventDefault — extracted with sync prelude
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const name = data.get('name');
    window.alert(`Submitted: ${name}`);
  }, []);

  // Another event handler using window API
  const handleScroll = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    localStorage.setItem('scrolled', 'true');
  };

  // Pure computation — should NOT be extracted (PureComputation stays in bundle)
  const total = useMemo(() => {
    return items.reduce((sum, item) => sum + item.price, 0);
  }, [items]);

  // Uses imported helper in a handler — tests import rewriting
  const handleFormat = () => {
    const formatted = formatCurrency(total);
    window.alert(`Total: ${formatted}`);
  };

  return (
    <div>
      <h1>Phantom Integration Test</h1>
      <p>Click count: {count}</p>
      <p>Total: {formatCurrency(total)}</p>

      <div onClick={handleClick}>
        <button>Click me (handler extracted to chunk)</button>
      </div>

      <form onSubmit={handleSubmit}>
        <input name="name" placeholder="Enter name" />
        <button type="submit">Submit (preventDefault hoisted)</button>
      </form>

      <button onClick={handleScroll}>Scroll to top</button>
      <button onClick={handleFormat}>Show formatted total</button>
    </div>
  );
}
