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
import { createContext, createElement, type FC, type ReactNode, useContext, useEffect, useState } from 'react';

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

// ── Handler type for React context ──
// value is ComponentData (base type). NodeData IS ComponentData.
// Renderers that need $path use usePath().

export type RenderProps = {
  value: ComponentData;
  onChange?: (next: ComponentData) => void;
};

export type ReactHandler = FC<RenderProps>;

declare module '@treenity/core/core/context' {
  interface ContextHandlers {
    react: ReactHandler;
  }
}

// ── SystemFallbackView — registered by UIX when a type has no custom view ──
// Renders default@context without going through type-specific resolve (avoids infinite loop).
export const SystemFallbackView: FC<RenderProps> = ({ value, onChange }) => {
  const context = useTreeContext();
  const def = resolve('default', context, false) as FC<RenderProps> | null;
  if (!def) return null;
  const el = createElement(def, { value, onChange });
  if ('$path' in value) return <NodeProvider value={value as NodeData}>{el}</NodeProvider>;
  return el;
};

// ── <Render> — component/node-level rendering ──

export function Render({ value, onChange }: RenderProps) {
  const context = useTreeContext();
  const type = value.$type;

  // Tree actual handler in state so React Compiler can't optimize away the update
  // (a dummy tick counter gets eliminated because its value is never read in render output)
  const [Handler, setHandler] = useState<ReactHandler | null>(
    () => resolveExact(type, context) as ReactHandler | null,
  );

  // Subscribe to registry bumps. When handler is registered async (UIX lazy load),
  // the callback fires and stores the resolved handler → triggers re-render.
  useEffect(() => {
    const found = resolveExact(type, context) as ReactHandler | null;
    if (found) { setHandler(() => found); return; }
    setHandler(null); // Clear stale handler when type/context changes
    if (hasMissResolver(context)) resolve(type, context);
    const unsub = subscribeRegistry(() => {
      const h = resolveExact(type, context) as ReactHandler | null;
      if (h) setHandler(() => h);
    });
    return unsub;
  }, [type, context]);

  // Fallback: if no exact handler, try default/parent context resolution
  let Final = Handler;
  if (!Final) {
    if (hasMissResolver(context)) {
      resolve(type, context);
      return null;
    }
    Final = resolve(type, context, false) as ReactHandler | null;
  }

  if (!Final) return null;
  const el = createElement(Final, { value, onChange });
  if ('$path' in value) return <NodeProvider value={value as NodeData}>{el}</NodeProvider>;
  return el;
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
