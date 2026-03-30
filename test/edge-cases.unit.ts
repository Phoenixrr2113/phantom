import { describe, it, expect } from 'vitest';
import { parseSync } from 'oxc-parser';
import { parseModule, analyzeModule } from '../src/analyzer.js';

/** Options that disable minHandlerSize so small test fixtures are still extracted */
const EXTRACT_ALL = { minHandlerSize: 0 };

describe('edge cases', () => {
  describe('malformed input', () => {
    it('parseModule throws PARSE_ERROR for malformed JSX', () => {
      expect(() => parseModule('<div unclosed', 'broken.tsx')).toThrow(
        '[phantom] PARSE_ERROR',
      );
    });

    it('parseModule PARSE_ERROR message includes file path and hint', () => {
      let errorMessage = '';
      try {
        parseModule('const x = {;', 'bad-syntax.ts');
      } catch (e: unknown) {
        errorMessage = (e as Error).message;
      }
      expect(errorMessage).toContain('bad-syntax.ts');
      expect(errorMessage).toContain('Hint:');
    });

    it('analyzeModule throws for files with syntax errors', () => {
      expect(() => analyzeModule('function broken( {', 'broken.tsx')).toThrow(
        '[phantom] PARSE_ERROR',
      );
    });

    it('parseModule throws for mismatched JSX tags', () => {
      expect(() =>
        parseModule(
          'function App() { return <div><span></div>; }',
          'mismatched.tsx',
        ),
      ).toThrow('[phantom] PARSE_ERROR');
    });
  });

  describe('TypeScript-only files (no runtime code)', () => {
    it('interface-only file produces no segments', () => {
      const code = `
        export interface UserProfile {
          id: number;
          name: string;
          email: string;
        }

        export interface ApiResponse<T> {
          data: T;
          error: string | null;
        }
      `;
      const result = analyzeModule(code, 'types.ts', EXTRACT_ALL);
      expect(result.segments).toEqual([]);
      expect(result.hasExtractions).toBe(false);
    });

    it('type alias-only file produces no segments', () => {
      const code = `
        export type EventName = 'click' | 'focus' | 'blur';
        export type Handler<T> = (event: T) => void;
        export type Nullable<T> = T | null;
      `;
      const result = analyzeModule(code, 'aliases.ts', EXTRACT_ALL);
      expect(result.segments).toEqual([]);
      expect(result.hasExtractions).toBe(false);
    });

    it('enum-only file produces no segments', () => {
      const code = `
        export enum Status {
          Active = 'active',
          Inactive = 'inactive',
          Pending = 'pending',
        }
      `;
      const result = analyzeModule(code, 'enums.ts', EXTRACT_ALL);
      expect(result.segments).toEqual([]);
      expect(result.hasExtractions).toBe(false);
    });
  });

  describe('re-export files', () => {
    it('barrel re-export file has no segments', () => {
      const code = `
        export { PaymentForm } from './PaymentForm';
        export { AddressForm } from './AddressForm';
        export type { FormProps } from './types';
      `;
      const result = analyzeModule(code, 'index.ts', EXTRACT_ALL);
      expect(result.segments).toEqual([]);
      expect(result.hasExtractions).toBe(false);
    });

    it('star re-export file has no segments', () => {
      const code = `
        export * from './components';
        export * from './hooks';
        export * from './utils';
      `;
      const result = analyzeModule(code, 'index.ts', EXTRACT_ALL);
      expect(result.segments).toEqual([]);
      expect(result.hasExtractions).toBe(false);
    });
  });

  describe('async event handlers', () => {
    it('async arrow function event handler is extracted', () => {
      const code = `
import React from 'react';
function App() {
  const handleSave = async (e) => {
    e.preventDefault();
    const response = await fetch('/api/save', { method: 'POST' });
    window.alert(await response.text());
  };
  return <button onClick={handleSave}>Save</button>;
}
      `;
      const result = analyzeModule(code, 'async-handler.tsx', EXTRACT_ALL);
      expect(result.hasExtractions).toBe(true);
      const chunkCode = result.chunkModules![0].code;
      expect(chunkCode).toContain('async');
      expect(chunkCode).toContain('await');

      // Client code must still be valid TSX
      const parsed = parseSync('client.tsx', result.clientCode!, {
        lang: 'tsx',
        sourceType: 'module',
      });
      expect(parsed.errors.length).toBe(0);
    });

    it('async function declaration event handler is extracted', () => {
      const code = `
import React from 'react';
function App() {
  async function handleDelete() {
    await fetch('/api/delete', { method: 'DELETE' });
    window.location.reload();
  }
  return <button onClick={handleDelete}>Delete</button>;
}
      `;
      const result = analyzeModule(code, 'async-fn.tsx', EXTRACT_ALL);
      expect(result.hasExtractions).toBe(true);
      const chunkCode = result.chunkModules![0].code;
      expect(chunkCode).toContain('async');
    });
  });

  describe('multiple components in one file', () => {
    it('finds event handlers across multiple components', () => {
      const code = `
import React from 'react';

function Header() {
  const handleMenuClick = () => { window.alert('menu'); };
  return <nav><button onClick={handleMenuClick}>Menu</button></nav>;
}

function Footer() {
  const handleNewsletterSubmit = (e) => {
    e.preventDefault();
    window.location.href = '/thank-you';
  };
  return <form onSubmit={handleNewsletterSubmit}><button>Subscribe</button></form>;
}

export { Header, Footer };
      `;
      const result = analyzeModule(code, 'multi-component.tsx', EXTRACT_ALL);
      expect(result.hasExtractions).toBe(true);
      // Both handlers should be in the grouped chunk module
      expect(result.extractedSegmentIds!.length).toBeGreaterThanOrEqual(2);
      // Only one grouped chunk module per file
      expect(result.chunkModules!.length).toBe(1);

      const chunkCode = result.chunkModules![0].code;
      // Both handler bodies should appear in the chunk
      const exportCount = (chunkCode.match(/export function/g) || []).length;
      expect(exportCount).toBeGreaterThanOrEqual(2);
    });

    it('chunks from multiple components are parseable', () => {
      const code = `
import React from 'react';

function FormA() {
  const handleSubmitA = (e) => {
    e.preventDefault();
    window.location.href = '/success-a';
  };
  return <form onSubmit={handleSubmitA}><button>A</button></form>;
}

function FormB() {
  const handleSubmitB = (e) => {
    e.preventDefault();
    window.location.href = '/success-b';
  };
  return <form onSubmit={handleSubmitB}><button>B</button></form>;
}

export { FormA, FormB };
      `;
      const result = analyzeModule(code, 'two-forms.tsx', EXTRACT_ALL);
      expect(result.hasExtractions).toBe(true);

      for (const mod of result.chunkModules!) {
        const parsed = parseSync('chunk.js', mod.code, {
          lang: 'js',
          sourceType: 'module',
        });
        expect(parsed.errors.length).toBe(0);
      }
    });
  });

  describe('static component (no handlers)', () => {
    it('component with only static JSX produces no extractions', () => {
      const code = `
import React from 'react';

function StaticBanner({ title, description }) {
  return (
    <div className="banner">
      <h1>{title}</h1>
      <p>{description}</p>
      <img src="/logo.png" alt="logo" />
    </div>
  );
}

export default StaticBanner;
      `;
      const result = analyzeModule(code, 'static-banner.tsx', EXTRACT_ALL);
      expect(result.hasExtractions).toBe(false);
      expect(result.clientCode).toBeUndefined();
    });

    it('component with conditional rendering but no handlers produces no extractions', () => {
      const code = `
import React from 'react';

function ConditionalList({ items, loading }) {
  if (loading) return <div>Loading...</div>;
  if (!items.length) return <p>No items</p>;
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}

export default ConditionalList;
      `;
      const result = analyzeModule(code, 'conditional-list.tsx', EXTRACT_ALL);
      expect(result.hasExtractions).toBe(false);
    });
  });

  describe('constants and object literals', () => {
    it('file with only constant declarations produces no segments', () => {
      const code = `
        export const API_URL = 'https://api.example.com';
        export const MAX_RETRIES = 3;
        export const TIMEOUT_MS = 5000;
        export const CONFIG = {
          debug: false,
          version: '1.0.0',
        };
      `;
      const result = analyzeModule(code, 'constants.ts', EXTRACT_ALL);
      expect(result.segments).toEqual([]);
      expect(result.hasExtractions).toBe(false);
    });
  });
});
