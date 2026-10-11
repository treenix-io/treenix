// UIX mod — dynamic JSX component engine
// Auto-discovered via import.meta.glob('../mods/*/client.ts')

import { getComponent, onResolveMiss, register, type NodeData } from '@treenx/core';
import type { Node } from '@treenx/core/kernel/types';
import type { RenderProps } from '#context';
import { usePath, useTreeEffects } from '#hooks';
import { useNativeTypeDescription } from '#schema-loader';
import { UixNoView } from '#context';
import React from 'react';
import { compileComponent, invalidateCache } from './compile';
import { UixSource } from './uix-source';

export { compileComponent, invalidateCache };

// ── UixView: self-rendering node ──
// Node shape: { $type: 'uix.view', code: { source: '...' } }
// Compiles JSX from the node's own `code.source` and renders it inline.

function LegacyUixView({ value, onChange }: { value: any; onChange?: (next: any) => void }) {
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

/** Native sources observe published ownership; legacy self-rendering code remains explicitly legacy. */
function UixView(props: RenderProps) {
  const effects = useTreeEffects();
  return effects.kernel === undefined
    ? React.createElement(LegacyUixView, props)
    : React.createElement(NativeTypeView, { ...props, type: props.value.$type });
}

register('uix.view', 'react', UixView);

// ── Lazy loader: the mounted provider owns type coverage ──

/** Keep canonical ownership under a real subscription without treating drafts as published handlers. */
function NativeTypeView({ type, ...props }: RenderProps & { type: string }) {
  const { data: ownership, loading, error } = usePath<Node>(`/sys/types/${type}`);
  const description = useNativeTypeDescription(type, ownership?.$rev);
  if (error !== null) return React.createElement('p', { role: 'alert' }, error.message);
  if (loading) return React.createElement('p', null, 'Loading type ownership…');
  if (ownership === undefined || description === undefined) return React.createElement(UixNoView, props);
  const view = description.view;
  if (view === undefined) return React.createElement(UixNoView, props);

  const Component = compileComponent(type, view.source, { skipRegister: true });
  return React.createElement(Component, props);
}

/** Existing legacy type-node code remains owned by its actual mounted legacy source. */
function LegacyTypeView({ type, ...props }: RenderProps & { type: string }) {
  const { data: node, loading, error } = usePath<NodeData>(`/sys/types/${type.replace(/\./g, '/')}`);
  if (error !== null) return React.createElement('p', { role: 'alert' }, error.message);
  if (loading) return React.createElement('p', null, 'Loading type view…');
  const source = node === undefined ? undefined : getComponent(node, UixSource, 'view')?.source;
  if (source === undefined) return React.createElement(UixNoView, props);

  try {
    const Component = compileComponent(type, source, { skipRegister: true });
    return React.createElement(Component, props);
  } catch (reason) {
    return React.createElement('p', { role: 'alert' }, reason instanceof Error ? reason.message : String(reason));
  }
}

/** Register a provider-aware rendering owner, never a module-global selected source or draft body. */
function typeView(type: string): React.FC<RenderProps> {
  function OwnedTypeView(props: RenderProps) {
    const effects = useTreeEffects();
    return React.createElement(effects.kernel === undefined ? LegacyTypeView : NativeTypeView, { ...props, type });
  }

  return OwnedTypeView;
}

onResolveMiss('react', type => register(type, 'react', type.includes('.') ? typeView(type) : UixNoView));
