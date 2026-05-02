// view() — ergonomic view registration
// view(Type, Component)              → register(Type, 'react', Component)
// view.list(Type, Component)         → register(Type, 'react:list', Component)
// view.compact(Type, Component)      → register(Type, 'react:compact', Component)
// view(Type, 'custom', Component)    → register(Type, 'react:custom', Component)

import { register, type Class } from '@treenx/core';
import type { FC } from 'react';
import type { OnChange, ViewCtx } from '#context';

type ViewProps<T> = {
  value: T & { $type: string; $path?: string };
  onChange?: (partial: OnChange<T>) => void;
  ctx: ViewCtx;
};

type SiteFn = {
  <T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  <T>(type: Class<T>, suffix: string, component: FC<ViewProps<T>>): void;
};

type ViewFn = {
  <T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  <T>(type: Class<T>, context: string, component: FC<ViewProps<T>>): void;

  list<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  compact<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  edit<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  preview<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  /** Register a site-only view. SSR pipeline resolves strictly here — no fallback to `react`. */
  site: SiteFn;
  /** Register the same view for both `react` and `site` contexts. */
  universal<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
};

function viewImpl(type: Class, ctxOrComponent: string | FC, maybeComponent?: FC): void {
  if (typeof ctxOrComponent === 'string') {
    register(type, `react:${ctxOrComponent}`, maybeComponent!);
  } else {
    register(type, 'react', ctxOrComponent);
  }
}

function siteImpl(type: Class, suffixOrComponent: string | FC, maybeComponent?: FC): void {
  if (typeof suffixOrComponent === 'string') {
    register(type, `site:${suffixOrComponent}`, maybeComponent!);
  } else {
    register(type, 'site', suffixOrComponent);
  }
}

export const view: ViewFn = Object.assign(viewImpl, {
  list: (type: Class, component: FC) => register(type, 'react:list', component),
  compact: (type: Class, component: FC) => register(type, 'react:compact', component),
  edit: (type: Class, component: FC) => register(type, 'react:edit', component),
  preview: (type: Class, component: FC) => register(type, 'react:preview', component),
  site: siteImpl,
  universal: (type: Class, component: FC) => {
    register(type, 'react', component);
    register(type, 'site', component);
  },
}) as ViewFn;
