// view() — typed declarations for client module manifests
// view(Type, Component)              → declaration for(Type, 'react', Component)
// view.list(Type, Component)         → declaration for(Type, 'react:list', Component)
// view.compact(Type, Component)      → declaration for(Type, 'react:compact', Component)
// view(Type, 'custom', Component)    → declaration for(Type, 'react:custom', Component)

import { type Class } from '@treenx/core';
import { declareView, type ClientViewDeclaration } from '#context/client-registry';
import type { FC } from 'react';
import type { OnChange, ViewCtx } from '#context';

type ViewProps<T> = {
  value: T & { $type: string; $path?: string };
  onChange?: (partial: OnChange<T>) => void;
  ctx: ViewCtx;
};

type AnyView = { render(props: ViewProps<any>): ReturnType<FC> }['render'];

type SiteFn = {
  <T>(type: Class<T>, component: FC<ViewProps<T>>): ClientViewDeclaration;
  <T>(type: Class<T>, suffix: string, component: FC<ViewProps<T>>): ClientViewDeclaration;
};

type ViewFn = {
  <T>(type: Class<T>, component: FC<ViewProps<T>>): ClientViewDeclaration;
  <T>(type: Class<T>, context: string, component: FC<ViewProps<T>>): ClientViewDeclaration;

  list<T>(type: Class<T>, component: FC<ViewProps<T>>): ClientViewDeclaration;
  compact<T>(type: Class<T>, component: FC<ViewProps<T>>): ClientViewDeclaration;
  edit<T>(type: Class<T>, component: FC<ViewProps<T>>): ClientViewDeclaration;
  preview<T>(type: Class<T>, component: FC<ViewProps<T>>): ClientViewDeclaration;
  /** Register a site-only view. SSR pipeline resolves strictly here — no fallback to `react`. */
  site: SiteFn;
  /** Register the same view for both `react` and `site` contexts. */
  universal<T>(type: Class<T>, component: FC<ViewProps<T>>): readonly ClientViewDeclaration[];
};

function viewImpl(
  type: Class,
  ctxOrComponent: string | AnyView,
  maybeComponent?: AnyView,
): ClientViewDeclaration {
  if (typeof ctxOrComponent === 'string') {
    return declareView(type, `react:${ctxOrComponent}`, maybeComponent!);
  } else {
    return declareView(type, 'react', ctxOrComponent);
  }
}

function siteImpl(
  type: Class,
  suffixOrComponent: string | AnyView,
  maybeComponent?: AnyView,
): ClientViewDeclaration {
  if (typeof suffixOrComponent === 'string') {
    return declareView(type, `site:${suffixOrComponent}`, maybeComponent!);
  } else {
    return declareView(type, 'site', suffixOrComponent);
  }
}

export const view: ViewFn = Object.assign(viewImpl, {
  list: (type: Class, component: AnyView) => declareView(type, 'react:list', component),
  compact: (type: Class, component: AnyView) => declareView(type, 'react:compact', component),
  edit: (type: Class, component: AnyView) => declareView(type, 'react:edit', component),
  preview: (type: Class, component: AnyView) => declareView(type, 'react:preview', component),
  site: siteImpl,
  universal: (type: Class, component: AnyView) => {
    return [declareView(type, 'react', component), declareView(type, 'site', component)];
  },
});
