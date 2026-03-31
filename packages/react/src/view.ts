// view() — ergonomic view registration
// view(Type, Component)              → register(Type, 'react', Component)
// view.list(Type, Component)         → register(Type, 'react:list', Component)
// view.compact(Type, Component)      → register(Type, 'react:compact', Component)
// view(Type, 'custom', Component)    → register(Type, 'react:custom', Component)

import { register, type Class } from '@treenity/core';
import type { FC } from 'react';
import type { OnChange, ViewCtx } from '#context';

type ViewProps<T> = {
  value: T & { $type: string; $path?: string };
  onChange?: (partial: OnChange<T>) => void;
  ctx?: ViewCtx | null;
};

type ViewFn = {
  <T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  <T>(type: Class<T>, context: string, component: FC<ViewProps<T>>): void;

  list<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  compact<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  edit<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
  preview<T>(type: Class<T>, component: FC<ViewProps<T>>): void;
};

function viewImpl(type: Class, ctxOrComponent: string | FC, maybeComponent?: FC): void {
  if (typeof ctxOrComponent === 'string') {
    register(type, `react:${ctxOrComponent}`, maybeComponent!);
  } else {
    register(type, 'react', ctxOrComponent);
  }
}

export const view: ViewFn = Object.assign(viewImpl, {
  list: (type: Class, component: FC) => register(type, 'react:list', component),
  compact: (type: Class, component: FC) => register(type, 'react:compact', component),
  edit: (type: Class, component: FC) => register(type, 'react:edit', component),
  preview: (type: Class, component: FC) => register(type, 'react:preview', component),
}) as ViewFn;
