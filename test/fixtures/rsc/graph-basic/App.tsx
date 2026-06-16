import { useState } from 'react';
import { Layout } from './Layout';
export function App(){ const [n,setN]=useState(0); return <Layout count={n} onInc={()=>setN(n+1)} />; }
