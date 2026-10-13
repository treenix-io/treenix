import { clientModules as sourceDeclarations } from './uix-source';
import { clientModules as mcpDeclarations } from './mcp';
// UIX mod — dynamic JSX component engine
// Auto-discovered via import.meta.glob('../mods/*/client.ts')

import { declareClientModule, type ClientViewDeclaration } from '#context/client-registry';
import type { Node } from '@treenx/core/kernel/types';
import { viewCtx, type RenderProps } from '#context';
import type { PresentationComponent } from '#tree/presentation';
import { usePath, useTreeEffects } from '#hooks';
import { useNativeTypeDescription } from '#schema-loader';
import { UixNoView } from '#context';
import React from 'react';
import { compileComponent, invalidateCache } from './compile';

export { compileComponent, invalidateCache };

// Published module ownership supplies every view body.


// ── Lazy loader: the mounted provider owns type coverage ──

/** Keep canonical ownership under a real subscription without treating drafts as published handlers. */
function NativeTypeView({ type, ...props }: RenderProps & { type: string }) {
  const effects = useTreeEffects();
  const { data: ownership, loading, error } = usePath<Node>(`/sys/types/${type}`);
  const description = useNativeTypeDescription(type, ownership?.$rev);
  const context = React.useRef(props.ctx);
  context.current = props.ctx;
  const scope = React.useMemo(
    () => ({
      execute: effects.execute,
      viewCtx: (value: PresentationComponent) => {
        const owner = context.current;
        return owner == null
          ? null
          : viewCtx(value, { node: owner.node, execute: effects.execute });
      },
    }),
    [effects],
  );
  const published = description?.view?.source;
  const Component = React.useMemo(
    () =>
      published === undefined
        ? undefined
        : compileComponent(type, published, { extraScope: scope }),
    [type, published, scope],
  );
  if (error !== null) return React.createElement('p', { role: 'alert' }, error.message);
  if (loading) return React.createElement('p', null, 'Loading type ownership…');
  if (ownership === undefined || description === undefined)
    return React.createElement(UixNoView, props);
  const view = description.view;
  if (view === undefined) return React.createElement(UixNoView, props);

  if (Component === undefined) throw new Error('Published view has no compiled component');
  return React.createElement(Component, props);
}

/** Register a provider-aware rendering owner, never a module-global selected source or draft body. */
function typeView(type: string): React.FC<RenderProps> {
  function OwnedTypeView(props: RenderProps) {
    return React.createElement(NativeTypeView, {
      ...props,
      type,
    });
  }

  return OwnedTypeView;
}

const typeViews = new Map<string, React.FC<RenderProps>>();

const module = declareClientModule('@treenx/react/uix',
  [{ type: 'uix.view', context: 'react', handler: typeView('uix.view') }],
  (type, context): ClientViewDeclaration | undefined => {
    if (context !== 'react') return undefined;
    let handler = typeViews.get(type);
    if (handler === undefined) {
      handler = type.includes('.') ? typeView(type) : UixNoView;
      typeViews.set(type, handler);
    }
    return { type, context, handler };
  },
);

export const clientModules = [...sourceDeclarations, ...mcpDeclarations, module];
