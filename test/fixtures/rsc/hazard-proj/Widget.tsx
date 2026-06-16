import { useState } from 'react';
export function Widget({title,onSave}:{title:string;onSave:()=>void}){ const [n]=useState(0); return <button onClick={onSave}>{title}{n}</button>; }
