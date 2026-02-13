import React, { useMemo } from 'react';

interface Product {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  inStock: boolean;
  rating: number;
}

export function ProductPage({ products }: { products: Product[] }) {
  const sorted = useMemo(() => {
    return products
      .filter(p => p.inStock)
      .sort((a, b) => b.rating - a.rating)
      .map(p => ({
        ...p,
        formattedPrice: `$${p.price.toFixed(2)}`,
        discount: p.originalPrice
          ? Math.round((1 - p.price / p.originalPrice) * 100)
          : 0,
      }));
  }, [products]);

  return <div>{sorted.map(p => <span key={p.id}>{p.name}</span>)}</div>;
}
