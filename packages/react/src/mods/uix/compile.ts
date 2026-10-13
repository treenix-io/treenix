// UIX Compile — JSX compilation + caching + registration pipeline
// Turns raw JSX/TSX code string into a React component

import { declareClientModule, declareView, type ClientRegistry } from '#context/client-registry';
import { Render, RenderContext, RenderField, useActions, viewCtx } from '#context';
import { useChildren, usePath, useTreeEffects } from '#hooks';
import { READ_ONLY_EFFECTS } from '#tree/effects';
import React from 'react';
import { compileJSX } from './jsx-parser';

// Scope injected into dynamic code — what AI components can use
const SCOPE: Record<string, unknown> = {
  React,
  h: React.createElement,
  Fragment: React.Fragment,
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useRef: React.useRef,
  Render,
  RenderContext,
  RenderField,
  usePath,
  useChildren,
  execute: READ_ONLY_EFFECTS.execute,
  useActions,
  useTreeEffects,
  viewCtx,
};

const cache = new Map<string, React.FC<any>>();
let scopedCaches = new WeakMap<Record<string, unknown>, Map<string, React.FC<any>>>();

/** Compiled closures belong to their injected capabilities, even when their source text is identical. */
function scopeCache(owner: Record<string, unknown>): Map<string, React.FC<any>> {
  let owned = scopedCaches.get(owner);
  if (owned === undefined) {
    owned = new Map();
    scopedCaches.set(owner, owned);
  }
  return owned;
}

// Strip import lines (resolved from scope), extract export default name
function prepareCode(code: string): { body: string; exportName: string | null } {
  const lines = code.split('\n');
  const body: string[] = [];
  let exportName: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('import ')) continue;

    if (trimmed.startsWith('export default ')) {
      const rest = trimmed.slice('export default '.length).trim();
      // `export default function Foo(` or `export default class Foo` — keep declaration, extract name
      const declMatch = rest.match(/^(function|class)\s+(\w+)/);
      if (declMatch) {
        exportName = declMatch[2];
        body.push(line.replace('export default ', ''));
      } else {
        // `export default Foo;` — just a name reference
        exportName = rest.replace(/;$/, '').trim();
      }
      continue;
    }

    if (trimmed.startsWith('export ')) {
      body.push(line.replace('export ', ''));
      continue;
    }

    body.push(line);
  }

  return { body: body.join('\n'), exportName };
}

export function compileComponent(
  type: string,
  rawCode: string,
  opts?: { extraScope?: Record<string, unknown>; registry?: ClientRegistry },
): React.FC<any> {
  function publish(component: React.FC<any>): React.FC<any> {
    opts?.registry?.publish(declareClientModule(`compiled:${type}`, [declareView(type, 'react', component)]));
    return component;
  }
  const cacheKey = type + '\0' + rawCode;
  const scopeOwner = opts?.extraScope;
  const ownedCache = scopeOwner === undefined ? cache : scopeCache(scopeOwner);
  const cached = ownedCache.get(cacheKey);
  if (cached) return publish(cached);

  const { body, exportName } = prepareCode(rawCode);
  const jsCode = compileJSX(body);

  const scope = { ...SCOPE, ...opts?.extraScope };

  // uix.add() capture for inline mode
  let captured: React.FC<any> | null = null;
  const uix = {
    add: (comp: React.FC<any>) => {
      captured = comp;
    },
  };

  const allScope = { ...scope, uix };
  const keys = Object.keys(allScope);
  const vals = Object.values(allScope);

  const fnBody = exportName ? `${jsCode}\nreturn ${exportName};` : `${jsCode}\nreturn null;`;

  const fn = new Function(...keys, fnBody);
  const result = fn(...vals);

  const Component = captured || result;
  if (!Component)
    throw new Error(
      `No component found in code for type "${type}". Use uix.add(Comp) or export default.`,
    );

  ownedCache.set(cacheKey, Component);
  return publish(Component);
}

export function invalidateCache(type?: string): void {
  scopedCaches = new WeakMap();
  if (type) {
    for (const [k] of cache) {
      if (k.startsWith(type + '\0')) cache.delete(k);
    }
  } else {
    cache.clear();
  }
}
