import { register } from '#core';
import { useCurrentNode } from '@treenx/react';
import { useChildren } from '@treenx/react';

register('ticker', 'react', () => {
  const node = useCurrentNode();
  const { data: prices } = useChildren(node.$path, { limit: 20, watchNew: true });

  return (
    <div className="space-y-1 p-2">
      <h3 className="font-bold">{node.$path}</h3>
      {prices.map(p => (
        <div key={p.$path} className="text-sm font-mono">
          ${(p as any).price?.toFixed(2)} — {new Date((p as any).ts).toLocaleTimeString()}
        </div>
      ))}
    </div>
  );
});
