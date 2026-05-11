// Sensor feed — live view of last N readings, auto-updates via watchNew

import { register } from '@treenx/core';
import { type View, useChildren } from '@treenx/react';
import { SensorDemo } from './types';

const MAX = 10;

const SensorFeed: View<SensorDemo> = ({ ctx }) => {
  const { data: children } = useChildren(ctx!.path, { watch: true, watchNew: true });
  const last = children.slice(-MAX).reverse();

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
        Live sensor feed ({children.length} total)
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {last.map((n, i) => {
          const ts = n.ts as number;
          const val = n.value as number;
          const seq = n.seq as number;
          const time = new Date(ts).toLocaleTimeString();
          const bar = Math.round(((val - 15) / 15) * 20);
          return (
            <div
              key={n.$path}
              style={{
                display: 'flex',
                gap: 8,
                padding: '4px 8px',
                background: i === 0 ? 'var(--accent-bg, rgba(99,102,241,0.15))' : 'var(--surface)',
                borderRadius: 'var(--radius)',
                transition: 'background 0.3s',
                opacity: 1 - i * 0.07,
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
        {last.length === 0 && (
          <div style={{ color: 'var(--text-3)', padding: 8 }}>Waiting for data...</div>
        )}
      </div>
    </div>
  );
}

register(SensorDemo, 'react', SensorFeed);
