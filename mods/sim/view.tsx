// AgentSim views — World map + Agent card + Item card
// WorldView: controls, spatial map with entities + proximity links, event log
// AgentView: profile, editable prompt, memory, event inbox
// ItemView: description card

import { getComponent, type NodeData, register } from '@treenx/core';
import { useCurrentNode } from '@treenx/react';
import { useChildren } from '@treenx/react';
import { trpc } from '@treenx/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type EventEntry,
  SimAi,
  SimConfig,
  SimDescriptive,
  SimEvents,
  SimMemory,
  SimNearby,
  SimPosition,
  SimRound,
} from './types';

type Link = { x1: number; y1: number; x2: number; y2: number; opacity: number };

function buildLinks(entities: NodeData[]): Link[] {
  const posByName = new Map<string, SimPosition & { $type: string }>();
  for (const a of entities) {
    const d = getComponent(a, SimDescriptive);
    const p = getComponent(a, SimPosition);
    if (d && p) posByName.set(d.name, p);
  }
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const a of entities) {
    const desc = getComponent(a, SimDescriptive);
    const pos = getComponent(a, SimPosition);
    const nearby = getComponent(a, SimNearby);
    if (!desc || !pos || !nearby?.agents) continue;
    for (const other of nearby.agents) {
      const key = [desc.name, other].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const op = posByName.get(other);
      if (!op) continue;
      const d = Math.sqrt((pos.x - op.x) ** 2 + (pos.y - op.y) ** 2);
      const maxR = Math.max(pos.radius, op.radius);
      links.push({
        x1: pos.x, y1: pos.y, x2: op.x, y2: op.y,
        opacity: maxR > 0 ? 0.15 + 0.35 * (1 - d / maxR) : 0.3,
      });
    }
  }
  return links;
}

const btn = {
  padding: '4px 12px',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: 11,
} as const;

function formatAction(e: EventEntry): string {
  const msg = (e.data as any)?.message;
  if (e.action.startsWith('speak') && msg) return `"${msg}"`;
  if (e.action === 'move') return `→ (${(e.data as any).x}, ${(e.data as any).y})`;
  if (e.action.includes('→')) return e.action;
  return e.action;
}

// ── WorldView ──

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function WorldView() {
  const node = useCurrentNode();
  const { data: children } = useChildren(node.$path, { watchNew: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  const call = useCallback((p: Parameters<typeof trpc.execute.mutate>[0]) => {
    setError(null);
    trpc.execute.mutate(p).catch((e) => setError(errMsg(e)));
  }, []);

  const cfg = getComponent(node, SimConfig);
  const round = getComponent(node, SimRound);
  const entities = children.filter((n: NodeData) => n.$type === 'sim.agent' || n.$type === 'sim.item');
  const W = cfg?.width ?? 600;
  const H = cfg?.height ?? 400;
  const log = round?.log ?? [];
  const lastRound = (round?.current ?? 1) - 1;
  const links = useMemo(() => buildLinks(entities), [entities]);

  const toggle = useCallback(() => {
    call({ path: node.$path, action: cfg?.running ? 'stop' : 'start' });
  }, [node.$path, cfg?.running, call]);

  const onMapClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!selected || !mapRef.current) return;
      const rect = mapRef.current.getBoundingClientRect();
      const x = Math.round(e.clientX - rect.left);
      const y = Math.round(e.clientY - rect.top);
      call({ path: selected, action: 'move', data: { x, y } });
    },
    [selected, call],
  );

  const setSpeed = useCallback(
    (delay: number) => {
      call({ path: node.$path, action: 'set-config', data: { roundDelay: delay } });
    },
    [node.$path, call],
  );

  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          onClick={toggle}
          style={{
            ...btn,
            background: cfg?.running ? 'var(--danger, #c44)' : 'var(--accent)',
            color: '#fff',
            fontWeight: 600,
          }}
        >
          {cfg?.running ? 'Stop' : 'Start'}
        </button>
        <span style={{ color: 'var(--text-2)' }}>R{round?.current ?? 0}</span>
        {round?.phase === 'thinking' && (
          <span style={{ color: 'var(--accent)' }}>thinking...</span>
        )}
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>|</span>
        {[1000, 3000, 5000, 10000].map((d) => (
          <button
            key={d}
            onClick={() => setSpeed(d)}
            style={{
              ...btn,
              background: cfg?.roundDelay === d ? 'var(--accent)' : 'var(--surface)',
              color: cfg?.roundDelay === d ? '#fff' : 'var(--text-2)',
            }}
          >
            {d / 1000}s
          </button>
        ))}
        <span style={{ color: 'var(--text-3)', marginLeft: 'auto', fontSize: 11 }}>
          {entities.length} entities
          {selected && ` · click map to move`}
        </span>
      </div>

      {error && (
        <div onClick={() => setError(null)} style={{ padding: '6px 12px', marginBottom: 8, background: 'var(--danger, #c44)', color: '#fff', borderRadius: 'var(--radius)', fontSize: 12, cursor: 'pointer' }}>
          {error}
        </div>
      )}

      {/* Map */}
      <div
        ref={mapRef}
        onClick={onMapClick}
        style={{
          position: 'relative',
          width: W,
          height: H,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          cursor: selected ? 'crosshair' : 'default',
        }}
      >
        <svg
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}
          width={W}
          height={H}
        >
          {links.map((l, i) => (
            <line
              key={i}
              x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
              stroke="var(--accent, #6366f1)"
              strokeWidth={1.5}
              opacity={l.opacity}
            />
          ))}
        </svg>

        {entities.map((a: NodeData) => {
          const pos = getComponent(a, SimPosition);
          const desc = getComponent(a, SimDescriptive);
          if (!pos) return null;
          const isSel = selected === a.$path;
          const isItem = a.$type === 'sim.item';
          return (
            <div key={a.$path}>
              <div
                style={{
                  position: 'absolute',
                  left: pos.x - pos.radius,
                  top: pos.y - pos.radius,
                  width: pos.radius * 2,
                  height: pos.radius * 2,
                  borderRadius: '50%',
                  border: `1px dashed ${isSel ? 'var(--accent)' : 'var(--border)'}`,
                  opacity: isSel ? 0.5 : 0.2,
                  pointerEvents: 'none',
                }}
              />
              <div
                onClick={(e) => { e.stopPropagation(); setSelected(isSel ? null : a.$path); }}
                style={{
                  position: 'absolute',
                  left: pos.x - (isItem ? 12 : 16),
                  top: pos.y - (isItem ? 12 : 16),
                  width: isItem ? 24 : 32,
                  height: isItem ? 24 : 32,
                  borderRadius: isItem ? 'var(--radius)' : '50%',
                  background: isItem ? 'var(--surface)' : 'var(--accent)',
                  border: isSel ? '2px solid #fff' : `1px solid ${isItem ? 'var(--border)' : 'transparent'}`,
                  boxShadow: isSel ? '0 0 0 2px var(--accent)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: isItem ? 14 : 16,
                  zIndex: 2,
                  cursor: 'pointer',
                }}
                title={`${desc?.name} (${pos.x}, ${pos.y}) r=${pos.radius} [${a.$type}]`}
              >
                {desc?.icon ?? '?'}
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y + (isItem ? 14 : 18),
                  transform: 'translateX(-50%)',
                  fontSize: 10,
                  color: isSel ? 'var(--accent)' : 'var(--text-2)',
                  fontWeight: isSel ? 600 : 400,
                  whiteSpace: 'nowrap',
                  zIndex: 2,
                  pointerEvents: 'none',
                }}
              >
                {desc?.name}
              </div>
            </div>
          );
        })}

        {entities.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
            No entities — add sim.agent or sim.item children
          </div>
        )}
      </div>

      {/* Event Log */}
      <div style={{ marginTop: 12, maxHeight: 240, overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Event Log ({log.length})
        </div>
        {log.length === 0 && (
          <div style={{ color: 'var(--text-3)', padding: 8 }}>No events yet — press Start</div>
        )}
        {[...log].reverse().map((e, i) => (
          <div
            key={`${e.ts}-${i}`}
            style={{
              display: 'flex',
              gap: 8,
              padding: '4px 8px',
              background: e.round === lastRound ? 'var(--accent-bg, rgba(99,102,241,0.08))' : 'transparent',
              borderRadius: 'var(--radius)',
              fontSize: 12,
            }}
          >
            <span style={{ minWidth: 28, color: 'var(--text-3)' }}>R{e.round}</span>
            <span>{e.icon}</span>
            <span style={{ color: 'var(--accent)', minWidth: 48 }}>{e.agent}</span>
            <span style={{ color: 'var(--text-2)', flex: 1 }}>{formatAction(e)}</span>
            {e.heardBy?.length ? (
              <span style={{ color: 'var(--text-3)', fontSize: 10 }}>
                heard: {e.heardBy.join(', ')}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AgentView ──

function AgentView() {
  const node = useCurrentNode();
  const desc = getComponent(node, SimDescriptive);
  const pos = getComponent(node, SimPosition);
  const mem = getComponent(node, SimMemory);
  const ai = getComponent(node, SimAi);
  const events = getComponent(node, SimEvents)?.entries ?? [];

  const [editPrompt, setEditPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savePrompt = useCallback(() => {
    if (editPrompt === null) return;
    setError(null);
    trpc.execute.mutate({ path: node.$path, action: 'update', data: { systemPrompt: editPrompt } })
      .catch((e) => setError(errMsg(e)));
    setEditPrompt(null);
  }, [node.$path, editPrompt]);

  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, maxWidth: 500 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>
          {desc?.icon ?? '?'}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{desc?.name ?? 'Agent'}</div>
          <div style={{ color: 'var(--text-2)', fontSize: 12 }}>{desc?.description}</div>
        </div>
      </div>

      {error && (
        <div onClick={() => setError(null)} style={{ padding: '6px 12px', marginBottom: 8, background: 'var(--danger, #c44)', color: '#fff', borderRadius: 'var(--radius)', fontSize: 12, cursor: 'pointer' }}>
          {error}
        </div>
      )}

      {pos && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--surface)', borderRadius: 'var(--radius)' }}>
          Position: ({pos.x}, {pos.y}) &middot; Radius: {pos.radius}
        </div>
      )}

      {/* System Prompt */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          System Prompt
          {editPrompt === null && (
            <button onClick={() => setEditPrompt(ai?.systemPrompt ?? '')} style={{ ...btn, fontSize: 10, padding: '2px 8px' }}>Edit</button>
          )}
        </div>
        {editPrompt !== null ? (
          <div>
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              style={{ width: '100%', minHeight: 80, padding: 8, borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={savePrompt} style={{ ...btn, background: 'var(--accent)', color: '#fff' }}>Save</button>
              <button onClick={() => setEditPrompt(null)} style={btn}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
            {ai?.systemPrompt ?? '(none)'}
          </div>
        )}
      </div>

      {/* Event Inbox */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Event Inbox ({events.length})
        </div>
        {events.length === 0 && <div style={{ color: 'var(--text-3)', padding: 8 }}>No events yet</div>}
        {[...events].reverse().slice(0, 15).map((e, i) => (
          <div key={i} style={{ padding: '3px 8px', fontSize: 11, color: 'var(--text-2)', display: 'flex', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', minWidth: 24 }}>R{e.round}</span>
            <span style={{ color: 'var(--accent)' }}>{e.from}</span>
            <span>{e.type}{e.to ? `→${e.to}` : ''}</span>
            <span style={{ flex: 1, color: 'var(--text-3)' }}>
              {(e.data as any)?.message ? `"${(e.data as any).message}"` : JSON.stringify(e.data).slice(0, 60)}
            </span>
          </div>
        ))}
      </div>

      {/* Memory */}
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Memory ({mem?.entries?.length ?? 0})
        </div>
        {(!mem?.entries || mem.entries.length === 0) && (
          <div style={{ color: 'var(--text-3)', padding: 8 }}>Empty memory</div>
        )}
        {mem?.entries?.map((e, i) => (
          <div key={i} style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text-2)', background: i === (mem.entries.length ?? 0) - 1 ? 'var(--accent-bg, rgba(99,102,241,0.08))' : 'transparent', borderRadius: 'var(--radius)' }}>
            {e}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ItemView ──

function ItemView() {
  const node = useCurrentNode();
  const desc = getComponent(node, SimDescriptive);
  const pos = getComponent(node, SimPosition);

  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, maxWidth: 400 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 'var(--radius)', background: 'var(--surface)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
          {desc?.icon ?? '?'}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{desc?.name ?? 'Item'}</div>
          <div style={{ color: 'var(--text-2)', fontSize: 12 }}>{desc?.description}</div>
        </div>
      </div>
      {pos && (
        <div style={{ padding: '8px 12px', background: 'var(--surface)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text-2)' }}>
          Position: ({pos.x}, {pos.y}) &middot; Radius: {pos.radius}
        </div>
      )}
    </div>
  );
}

register('sim.world', 'react', WorldView as any);
register('sim.agent', 'react', AgentView as any);
register('sim.item', 'react', ItemView as any);
