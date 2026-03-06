// Treenity React Binding — Layer 2
// <Render> + <RenderContext> + <NodeProvider>
// Depends on: core (resolve), React

import {
  type ComponentData,
  hasMissResolver,
  type NodeData,
  resolve,
  resolveExact,
  subscribeRegistry,
} from '@treenity/core/core';
import { createContext, createElement, type FC, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { execute } from '#hooks';
import { $key, $node } from '#symbols';

// ── Tree context (rendering context string) ──

const TreeContext = createContext<string>('react');

export function useTreeContext(): string {
  return useContext(TreeContext);
}

export function RenderContext({ name, children }: { name: string; children: ReactNode }) {
  return <TreeContext.Provider value={name}>{children}</TreeContext.Provider>;
}

// ── Node context — gives any renderer access to the current node ──

const NodeCtx = createContext<NodeData | null>(null);

export function NodeProvider({ value, children }: { value: NodeData | null; children: ReactNode }) {
  if (!value?.$path) return null;
  return <NodeCtx.Provider value={value}>{children}</NodeCtx.Provider>;
}

export function useCurrentNode(): NodeData {
  const n = useContext(NodeCtx);
  if (!n) throw new Error('useCurrentNode: no node in context');
  return n;
}

// ── viewCtx — derive location context from value's symbol metadata ──

export type ViewCtx = {
  node: NodeData;
  path: string;
  execute(action: string, data?: unknown): Promise<unknown>;
};

export function viewCtx(value: ComponentData): ViewCtx | null {
  const node: NodeData | undefined = (value as any)[$node];
  if (!node) return null;
  const key: string = (value as any)[$key] ?? '';
  const path = key ? `${node.$path}#${key}` : node.$path;
  return { node, path, execute: (action, data?) => execute(path, action, data) };
}

// ── Handler type for React context ──
// value is ComponentData (base type). NodeData IS ComponentData.

export type RenderProps<T = ComponentData> = {
  value: T;
  onChange?: (next: T) => void;
  ctx?: ViewCtx | null;
};

export type ReactHandler = FC<RenderProps<any>>;

/** Typed view component. Use: `const MyView: View<MyType> = ({ value, ctx }) => ...` */
export type View<T> = FC<RenderProps<T>>;

declare module '@treenity/core/core/context' {
  interface ContextHandlers<T> {
    react: FC<RenderProps<T>>;
  }
}

// ── UixNoView — registered by UIX when a type has no custom view yet ──
// Renders default@context without going through type-specific resolve (avoids infinite loop).
export const UixNoView: FC<RenderProps> = ({ value, onChange }) => {
  const context = useTreeContext();
  const def = resolve('default', context, false) as FC<RenderProps> | null;
  if (!def) return null;
  return createElement(def, { value, onChange });
};

// ── <Render> — component/node-level rendering ──

export function Render({ value, onChange }: RenderProps) {
  const context = useTreeContext();
  const type = value.$type;

  const ctx_ = context as 'react';
  const sync = useMemo(() => resolveExact(type, ctx_), [type, ctx_]);
  const [async_, setAsync] = useState<ReactHandler | null>(null);

  useEffect(() => {
    if (sync) return;
    setAsync(null);
    if (hasMissResolver(ctx_)) resolve(type, ctx_);

    return subscribeRegistry(() => {
      const h = resolveExact(type, ctx_);
      if (h) setAsync(() => h);
    });
  }, [type, ctx_, sync]);

  let Handler = sync ?? async_;

  if (!Handler) {
    if (hasMissResolver(ctx_)) {
      resolve(type, ctx_);
      return null;
    }
    Handler = resolve(type, ctx_, false);
  }

  if (!Handler) return null;

  const ctx = viewCtx(value);
  return createElement(Handler, { value, onChange, ctx });
}

// ── <RenderField> — field-level rendering by type name ──
// Bridge between block renderers (primitive values) and form-field handlers ({ $type, value }).
// Wraps primitive → component shape on the way in, extracts .value on the way out.

export function RenderField({ type = 'string', value, onChange, ...rest }: { type?: string; value?: unknown; onChange?: (v: unknown) => void; [k: string]: unknown }) {
  const ctx = useTreeContext();
  const handler = resolve(type, ctx);
  if (!handler) return value != null ? <span>{String(value)}</span> : null;

  // Already component-shaped? pass through. Otherwise wrap primitive.
  const wrapped = value && typeof value === 'object' && '$type' in (value as object)
    ? value
    : { $type: type, value, ...rest };

  const handleChange = onChange
    ? (next: unknown) => onChange(next && typeof next === 'object' && 'value' in (next as object) ? (next as any).value : next)
    : undefined;

  return createElement(handler as FC<Record<string, unknown>>, { value: wrapped, onChange: handleChange });
}
