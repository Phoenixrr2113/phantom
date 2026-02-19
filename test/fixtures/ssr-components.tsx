import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

// ── FullyStatic: pure props → JSX, no hooks, no handlers ─────────────
export function StaticBanner({ title }: { title: string }) {
  return (
    <div className="banner">
      <h1>{title}</h1>
    </div>
  );
}

// ── SSRSafe: has state but clean render path ──────────────────────────
export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>
  );
}

// ── ClientOnly: browser API in render path ────────────────────────────
export function WindowSize() {
  const width = window.innerWidth;
  return <span>Width: {width}</span>;
}

// ── SSRSafe: browser API guarded by typeof window ─────────────────────
export function SafeComponent() {
  let stored = '';
  if (typeof window !== 'undefined') {
    stored = localStorage.getItem('key') || '';
  }
  return <div>{stored}</div>;
}

// ── SSRSafe: browser API in useEffect only ────────────────────────────
export function EffectComponent() {
  const [title, setTitle] = useState('');

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <input value={title} onChange={(e) => setTitle(e.target.value)} />
  );
}

// ── SSRSafe: event handler references browser APIs ────────────────────
export function ScrollButton() {
  const handleClick = useCallback(() => {
    window.scrollTo(0, 0);
    localStorage.setItem('scrolled', 'true');
  }, []);

  return <button onClick={handleClick}>Scroll to top</button>;
}

// ── SSRSafe: useMemo with pure computation ────────────────────────────
export function ComputedList({ items }: { items: string[] }) {
  const sorted = useMemo(() => [...items].sort(), [items]);

  return (
    <ul>
      {sorted.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
