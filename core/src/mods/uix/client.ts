// UIX mod — dynamic JSX component engine
// Auto-discovered via import.meta.glob('../mods/*/client.ts')

import { getComponent, onResolveMiss, register, unregister } from '#core';
import { createInflight } from '#tree/inflight';
import { cache, tree, UixNoView } from '@treenx/react';
import React from 'react';
import { compileComponent, invalidateCache } from './compile';
import { UixSource } from './uix-source';

export { compileComponent, invalidateCache };

// ── Error view — loud inline error when view compilation fails ──

function createErrorView(type: string, error: string) {
  const ErrorView: React.FC<any> = () =>
    React.createElement('div', { className: 'p-4 m-2 rounded-lg bg-red-950 border border-red-700' },
      React.createElement('div', { className: 'text-red-400 font-semibold text-sm mb-1' },
        `View compile error: ${type}`),
      React.createElement('pre', { className: 'text-red-300 text-xs whitespace-pre-wrap' }, error),
    );
  ErrorView.displayName = `UIXError(${type})`;
  return ErrorView;
}

// ── UixView: self-rendering node ──
// Node shape: { $type: 'uix.view', code: { source: '...' } }
// Compiles JSX from the node's own `code.source` and renders it inline.

function UixView({ value, onChange }: { value: any; onChange?: (next: any) => void }) {
  const source = value.code?.source;
  if (!source || typeof source !== 'string') {
    return React.createElement('div', { className: 'p-4 text-gray-400' }, 'uix.view — no code.source');
  }

  const id = value.$path || 'uix.anon';

  try {
    const Comp = compileComponent(id, source, { skipRegister: true });
    return React.createElement(Comp, { value, onChange });
  } catch (err: any) {
    return React.createElement('pre', { className: 'p-4 text-red-500 text-sm whitespace-pre-wrap' },
      `UIX compile error:\n${err.message}`);
  }
}

register('uix.view', 'react', UixView);

// ── Lazy loader: resolve miss → check type node for view.source ──
// When resolve(type, 'react') misses, fetch /sys/types/{type} and compile if it has a view.
// All UIX logic stays here — no other module knows about dynamic views.

// Dedup concurrent fetches for the same type. Auto-clears on settle so retries work.
const dedup = createInflight<void>();

// Watch a type node for future view creation (e.g. AI agent saves view.source via MCP).
// When the node changes and gains view.source, swap UixNoView for the real view.
const watched = new Set<string>();

function watchTypeNode(type: string, typePath: string) {
  if (watched.has(type)) return;
  watched.add(type);

  const unsub = cache.subscribePath(typePath, () => {
    const node = cache.get(typePath);
    const source = node ? getComponent(node, UixSource, 'view')?.source : undefined;
    if (!source) return;

    // View appeared — swap fallback for real compiled view
    unsub();
    watched.delete(type);
    unregister(type, 'react');
    invalidateCache(type);

    try {
      compileComponent(type, source);
      console.log(`[uix] hot-loaded view for "${type}"`);
    } catch (err: any) {
      register(type, 'react', createErrorView(type, err.message));
      console.error(`[uix] failed to hot-compile view for "${type}":`, err.message);
    }
  });
}

onResolveMiss('react', (type) => {
  // Built-in types (no dot) never have UIX views — avoid contaminating tRPC batches
  if (!type.includes('.')) {
    register(type, 'react', UixNoView);
    return;
  }

  // Types mount converts dots to path segments: foo.bar → /sys/types/foo/bar
  const typePath = `/sys/types/${type.replace(/\./g, '/')}`;

  dedup(type, async () => {
    const typeNode = await tree.get(typePath);
    const source = typeNode ? getComponent(typeNode, UixSource, 'view')?.source : undefined;

    if (!source) {
      register(type, 'react', UixNoView);
      // Watch for future view creation (e.g. AI agent saves view.source later)
      watchTypeNode(type, typePath);
      return;
    }

    try {
      compileComponent(type, source);
    } catch (err: any) {
      register(type, 'react', createErrorView(type, err.message));
      watchTypeNode(type, typePath);
      console.error(`[uix] failed to compile view for "${type}":`, err.message);
    }
  }).catch((err: any) => {
    console.warn(`[uix] failed to fetch type "${type}":`, err?.message ?? err);
  });
});
