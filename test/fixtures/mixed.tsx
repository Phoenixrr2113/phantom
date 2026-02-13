import React, { useMemo, useCallback, useEffect, useState } from 'react';

interface Item {
  id: string;
  name: string;
  value: number;
}

export function MixedComponent({ items }: { items: Item[] }) {
  const [filter, setFilter] = useState('');

  // Pure computation — server candidate
  const total = useMemo(() => {
    return items.reduce((sum, item) => sum + item.value, 0);
  }, [items]);

  // Pure computation — server candidate
  const filtered = useMemo(() => {
    return items
      .filter(item => item.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, filter]);

  // Client interactive — touches DOM
  useEffect(() => {
    document.title = `${filtered.length} items`;
    return () => {
      document.title = 'App';
    };
  }, [filtered.length]);

  // Client interactive — event handler with DOM access
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    console.log(data);
  }, []);

  // Pure formatting helper — server candidate
  const formatValue = (value: number) => {
    return `$${value.toFixed(2)}`;
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={filter} onChange={e => setFilter(e.target.value)} />
      <p>Total: {formatValue(total)}</p>
      {filtered.map(item => (
        <div key={item.id}>{item.name}: {formatValue(item.value)}</div>
      ))}
    </form>
  );
}
