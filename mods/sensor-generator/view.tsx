// Sensor generator — on-demand scan, streams results via streamAction subscription

import { type NodeData, register } from '@treenx/core';
import { treeClient, useCurrentNode } from '@treenx/react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Reading = NodeData<{ value: number; seq: number; ts: number }>;

function GeneratorDemo() {
  const node = useCurrentNode();
  const [items, setItems] = useState<Reading[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const scan = useCallback(() => {
    unsubRef.current?.();
    setItems([]);
    setError(null);
    setRunning(true);
    const id = treeClient.sub<Reading>({
      kind: 'action', action: { path: node.$path, action: 'scan', args: { count: 10, delay: 500 } },
      observer: {
        next: reading => setItems(prev => [...prev, reading]),
        complete: () => setRunning(false),
        error: reason => {
          setRunning(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      },
    });
    unsubRef.current = () => treeClient.cancel(id);
  }, [node.$path]);

  useEffect(() => () => { unsubRef.current?.(); unsubRef.current = null; }, [node.$path]);

  const stop = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setRunning(false);
  }, []);

  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
      {error && <p role="alert" className="text-destructive">{error}</p>}
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
          const val = n.value;
          const seq = n.seq;
          const time = new Date(n.ts).toLocaleTimeString();
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
