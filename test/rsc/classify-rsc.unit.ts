import { describe, it, expect } from 'vitest';
import { classifyFileRsc } from '../../src/rsc/classify-rsc.js';

describe('classifyFileRsc', () => {
  it('pure props→JSX file is server-eligible', () => {
    const code = `export function Card({title}:{title:string}){return <div>{title}</div>;}`;
    const r = classifyFileRsc(code, '/x/Card.tsx');
    expect(r.fileVerdict).toBe('server-eligible');
    expect(r.components[0].verdict).toBe('server-eligible');
  });
  it('useState file is must-be-client with reason', () => {
    const code = `import {useState} from 'react';export function C(){const[n,s]=useState(0);return <button onClick={()=>s(n+1)}>{n}</button>;}`;
    const r = classifyFileRsc(code, '/x/C.tsx');
    expect(r.fileVerdict).toBe('must-be-client');
    expect(r.components[0].reason).toMatch(/useState|hook|state/i);
  });
  it('file mixing static + stateful components is "mixed" (split candidate)', () => {
    const code = `import {useState} from 'react';
export function Static({t}:{t:string}){return <p>{t}</p>;}
export function Live(){const[n,s]=useState(0);return <button onClick={()=>s(n+1)}>{n}</button>;}`;
    const r = classifyFileRsc(code, '/x/M.tsx');
    expect(r.fileVerdict).toBe('mixed');
  });
});
