// Sensor generator — on-demand scan, streams results via streamAction subscription

import { type NodeData, register } from '@treenx/core';
import { useCurrentNode } from '@treenx/react';
import { trpc } from '@treenx/react';
import { useCallback, useRef, useState } from 'react';

function GeneratorDemo() {
  const node = useCurrentNode();
  const [items, setItems] = useState<NodeData[]>([]);
  const [running, setRunning] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const scan = useCallback(() => {
    unsubRef.current?.();
    setItems([]);
    setRunning(true);
    const sub = trpc.streamAction.subscribe(
      { path: node.$path, action: 'scan', data: { count: 10, delay: 500 } },
      {
        onData: (item) => {
          const n = item as NodeData;
          if (n?.$path) setItems((prev) => [...prev, n]);
        },
        onComplete: () => setRunning(false),
        onError: () => setRunning(false),
      },
    );
    unsubRef.current = () => sub.unsubscribe();
  }, [node.$path]);

  const stop = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setRunning(false);
  }, []);

  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 8,
        }}
      >
        Generator scan {running && `(${items.length}/10)`}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button
          onClick={running ? stop : scan}
          style={{
            padding: '4px 12px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: running ? 'var(--danger, #c44)' : 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {running ? 'Stop' : 'Scan'}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((n, i) => {
          const val = n.value as number;
          const seq = n.seq as number;
          const time = new Date(n.ts as number).toLocaleTimeString();
          const bar = Math.round(((val - 15) / 15) * 20);
          return (
            <div
              key={n.$path}
              style={{
                display: 'flex',
                gap: 8,
                padding: '4px 8px',
                background:
                  i === items.length - 1
                    ? 'var(--accent-bg, rgba(99,102,241,0.15))'
                    : 'var(--surface)',
                borderRadius: 'var(--radius)',
                transition: 'background 0.3s',
              }}
            >
              <span style={{ color: 'var(--text-3)', minWidth: 32 }}>#{seq}</span>
              <span style={{ color: 'var(--text-2)', minWidth: 70 }}>{time}</span>
              <span style={{ color: 'var(--accent)', minWidth: 50, textAlign: 'right' }}>
                {val}°
              </span>
              <span style={{ color: 'var(--accent)', opacity: 0.5 }}>
                {'█'.repeat(Math.max(0, bar))}
              </span>
            </div>
          );
        })}
        {items.length === 0 && !running && (
          <div style={{ color: 'var(--text-3)', padding: 8 }}>Press Scan to generate readings</div>
        )}
      </div>
    </div>
  );
}

register('examples.demo.generator', 'react', GeneratorDemo);
