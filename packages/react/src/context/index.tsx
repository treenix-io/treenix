import type { PresentationComponent, PresentationNode } from '#tree/presentation';
// Treenix React Binding — Layer 2
// <Render> + <RenderContext> + <NodeProvider>
// Depends on: source-owned client contexts, React

import { useTreeEffects } from '#hooks';
import { useClientRegistry } from './client-registry-context';
import { formatContext, parseContext } from '#context/selectors';
import { READ_ONLY_EFFECTS, type TreeEffects } from '#tree/effects';
import { $key, $node } from '#symbols';
import { type OnChange, scopeOnChange } from '#tree/on-change';
import type { Actions as CoreActions } from '@treenx/core/comp';
import {
  getComponentByName,
  type ComponentData,
  type NodeData,
} from '@treenx/core';
import {
  createContext,
  createElement,
  type FC,
  type ReactNode,
  useContext,
  useMemo,
} from 'react';

// ── Tree context (base and inherited modifiers) ──

const TreeContext = createContext(parseContext('react'));

export function useTreeContext(): string {
  return formatContext(useContext(TreeContext));
}

export function RenderContext({ name, children }: { name: string; children: ReactNode }) {
  const inherited = useContext(TreeContext);
  const context = useMemo(() => parseContext(name, inherited), [name, inherited]);
  return <TreeContext.Provider value={context}>{children}</TreeContext.Provider>;
}

// ── Node context — gives any renderer access to the current node ──

const NodeCtx = createContext<PresentationNode | null>(null);

export function NodeProvider({
  value,
  children,
}: {
  value: PresentationNode | null;
  children?: ReactNode;
}) {
  if (!value?.$path) return null;
  return <NodeCtx.Provider value={value}>{children}</NodeCtx.Provider>;
}

export function useCurrentNode(): PresentationNode {
  const n = useContext(NodeCtx);
  if (!n) throw new Error('useCurrentNode: no node in context');
  return n;
}

// ── viewCtx — derive location context from value's symbol metadata ──

export type ViewCtx = {
  node: PresentationNode;
  path: string;
  execute(action: string, data?: unknown): Promise<unknown>;
};

/** Derive an action context from an explicit source owner; detached metadata carries no mutation capability. */
export function viewCtx(
  value: PresentationComponent,
  owner?: { readonly node: PresentationNode; readonly execute: TreeEffects['execute'] },
): ViewCtx | null {
  if (owner !== undefined) {
    const path = nativeLocation(value, owner.node);
    return path === undefined
      ? null
      : { node: owner.node, path, execute: (action, data) => owner.execute(path, action, data) };
  }
  const node: NodeData | undefined = (value as any)[$node];
  if (!node) return null;
  const key: string = (value as any)[$key] ?? '';
  const path = key ? `${node.$path}#${key}` : node.$path;
  return { node, path, execute: (action, data?) => READ_ONLY_EFFECTS.execute(path, action, data) };
}

// ── Handler type for React context ──
// value is ComponentData (base type). NodeData IS ComponentData.

export type { OnChange };
export { scopeOnChange };

export type RenderProps<T = PresentationComponent> = {
  value: T;
  onChange?: (partial: OnChange<T>) => void;
  ctx?: ViewCtx | null;
};

export type ReactHandler = FC<RenderProps<any> & Record<string, unknown>>;

/** Typed view component. Use: `const MyView: View<MyType> = ({ value, ctx }) => ...` */
export type View<T, Extra = {}> = FC<RenderProps<T> & Extra>;

// ── useActions — proxy that turns value's symbol metadata into action calls ──

type Actions<T> = {
  [K in keyof CoreActions<T>]: CoreActions<T>[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R>
    : CoreActions<T>[K] extends (...args: infer A) => unknown
      ? (...args: A) => Promise<unknown> : never;
};

/** Finds an admitted node or its exact named component without decorating the payload. */
function nativeLocation(value: object, current: PresentationNode | null): string | undefined {
  if (current === null) return undefined;
  if (value === current) return current.$path;
  for (const name of Object.keys(current)) {
    if (name.startsWith('#') && getComponentByName(current, name.slice(1)) === value)
      return `${current.$path}${name}`;
  }
  return undefined;
}

/** Distinguishes a whole node from a named component for render ownership. */
function isPresentationNode(value: PresentationComponent): value is PresentationNode {
  return typeof value.$path === 'string';
}

export function useActions<T extends object>(value: T): Actions<T> {
  const effects = useTreeEffects();
  const current = useContext(NodeCtx);
  const path = nativeLocation(value, current);
  if (path === undefined)
    throw new Error('useActions: component does not belong to the current node');

  return useMemo(
    () =>
      new Proxy({} as Actions<T>, {
        get: (_target, prop: string) => (data?: unknown) => effects.execute(path, prop, data),
      }),
    [path, effects],
  );
}

declare module '@treenx/core' {
  interface ContextHandlers<T> {
    // method syntax = bivariant: View<T, Extra> assignable without casts
    react(props: RenderProps<T>): ReturnType<FC>;
  }
}

// ── UixNoView — registered by UIX when a type has no custom view yet ──
// Renders default@context without going through type-specific resolve (avoids infinite loop).
export const UixNoView: FC<RenderProps> = ({ value, onChange, ctx }) => {
  const context = useContext(TreeContext);
  const registry = useClientRegistry();
  const def = registry.resolve('default', context, false)?.handler;
  if (!def) return null;
  return createElement(def, { value, onChange, ...(ctx === undefined ? {} : { ctx }) });
};

// ── <Render> — component/node-level rendering ──

export function Render<E extends Record<string, unknown> = {}>({
  value,
  onChange,
  ctx: suppliedContext,
  ...extra
}: RenderProps & E) {
  const context = useContext(TreeContext);
  const effects = useTreeEffects();
  const current = useContext(NodeCtx);
  const type = value.$type;
  const registry = useClientRegistry();
  const entry = registry.resolve(type, context);

  if (!entry) {
    console.warn(`[Render] no handler for ${type}@${formatContext(context)}`);
    return null;
  }

  // Registration-time props: register(type, ctx, Comp, { props: {...} }) — the SAME component can
  // serve several contexts with different presets; identical element type means React keeps the
  // instance mounted across a context toggle (e.g. canvas react ↔ react:edit keeps pan/zoom).
  const preset = entry.meta?.props;
  const regProps = preset && typeof preset === 'object' ? preset : undefined;

  const owner = isPresentationNode(value) ? value : current;
  const derived = owner === null ? null : viewCtx(value, { node: owner, execute: effects.execute });
  const ctx = suppliedContext === undefined ? derived : suppliedContext;
  const el = createElement(entry.handler, {
    value,
    onChange,
    ctx,
    ...extra,
    ...regProps,
  } as RenderProps);
  return ctx?.node ? createElement(NodeProvider, { value: ctx.node }, el) : el;
}

// ── <RenderField> — field-level rendering by type name ──
// Bridge between block renderers (primitive values) and form-field handlers ({ $type, value }).
// Wraps primitive → component shape on the way in, extracts .value on the way out.

export function RenderField({
  type = 'string',
  value,
  onChange,
  ...rest
}: {
  type?: string;
  value?: unknown;
  onChange?: (v: unknown) => void;
  [k: string]: unknown;
}) {
  const ctx = useContext(TreeContext);
  const registry = useClientRegistry();
  const handler = registry.resolve(type, ctx)?.handler;
  if (!handler) return value != null ? <span>{String(value)}</span> : null;

  // Already component-shaped? pass through. Otherwise wrap primitive.
  const wrapped =
    value && typeof value === 'object' && '$type' in (value as object)
      ? value
      : { $type: type, value, ...rest };

  const handleChange = onChange
    ? (next: unknown) =>
        onChange(
          next && typeof next === 'object' && 'value' in (next as object)
            ? (next as any).value
            : next,
        )
    : undefined;

  return createElement(handler as FC<Record<string, unknown>>, {
    value: wrapped,
    onChange: handleChange,
  });
}
