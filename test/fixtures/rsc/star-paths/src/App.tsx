import { useState } from 'react';
import { Helper } from '@/Helper';
import { Local } from './Local';

export function App() {
  const [n] = useState(0);
  return (
    <div>
      <Helper />
      <Local />
      {n}
    </div>
  );
}
