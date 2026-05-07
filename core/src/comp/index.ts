// Treenix Component Registration — between core and server
// registerType(type, cls) → stamps $type, registers class, auto-registers actions from methods

import { registerActionNeeds } from '#comp/needs';
import {
  type Class,
  ComponentData,
  getComponent,
  getContextsForType,
  NodeData,
  normalizeType,
  register,
  resolve,
  type TypeId,
  unregister,
} from '#core';
// Wire ExecCtx into logger — safe (returns null outside action context)
import { setCtxProvider } from '#log';
import { trackType } from '#mod/tracking';
import { type TypeSchema } from '#schema/types';
import { type Tree } from '#tree';

export type { Class };
export type TypeClass<T> = Class<T> & { $type: string };

// Strip methods from a type — only keep data fields (recursive)
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type Raw<T> = { [K in keyof T as T[K] extends Function ? never : K]: T[K] extends (infer U)[] ? U extends object ? Raw<U>[] : T[K] : T[K] extends object ? Raw<T[K]> : T[K] };

// Actions<T>: map class methods to typed async client signatures
// Uses Parameters<>/ReturnType<> to avoid TypeScript's "() => T extends (x: D) => T" false-match.
// Arity: Parameters<fn> extends [infer D, ...] → (data: D); else → ()
// Internal `deps` second-arg is absorbed by `...any[]` and dropped from client type.
// Generator methods (async *) → AsyncIterable<Y>; regular → Promise<R>
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type _AnyFn = (...args: any[]) => any;
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type _ToFn<T> = T extends _AnyFn ? T : never;

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type Actions<T> = {
  [K in keyof T as T[K] extends Function ? K : never]:
    ReturnType<_ToFn<T[K]>> extends AsyncGenerator<infer Y, any, any>
      ? Parameters<_ToFn<T[K]>> extends [infer D, ...any[]]
        ? (data: D) => AsyncIterable<Y>
        : () => AsyncIterable<Y>
    : Parameters<_ToFn<T[K]>> extends [infer D, ...any[]]
      ? (data: D) => Promise<Awaited<ReturnType<_ToFn<T[K]>>>>
      : () => Promise<Awaited<ReturnType<_ToFn<T[K]>>>>
};

// TypeProxy<T>: readonly data fields + async action methods
export type TypeProxy<T> = Raw<T> & Actions<T>;

declare module '#core/context' {
  interface ContextHandlers {
    class: Class<object>;
  }
}

// ── Action context for class methods ──
// Node.js: AsyncLocalStorage (survives await, concurrent-safe)
// Browser: global _ctx fallback (NOT safe with concurrent async actions — needs polyfill)

let _als: any = null;
let _ctx: ExecCtx | null = null;

// Top-level await: guarantees _als is ready before any action runs.
// Browser: import fails → _als stays null → falls back to _ctx global.
try { _als = new (await import('node:async_hooks')).AsyncLocalStorage(); }
catch {}

setCtxProvider(() => _als?.getStore() ?? _ctx);

export type ExecCtx = { node: NodeData; tree: Tree; signal: AbortSignal; [k: string]: unknown };

export function getCtx(): ExecCtx {
  const ctx = _als?.getStore() ?? _ctx;
  if (!ctx) throw new Error('getCtx(): called outside action context');
  return ctx;
}

// ── Registration ──

// Port declaration: which component fields an action reads (pre) and writes (post).
// Stored as registry meta on action:* contexts. Queried via comp/ports.ts and comp/planner.ts.
export type PortDecl = { pre?: string[]; post?: string[] };
type CompOptions = { needs?: string[]; ports?: Record<string, PortDecl>; override?: boolean; noOptimistic?: string[] };
const AsyncGenFn = Object.getPrototypeOf(async function* () { }).constructor;

export function registerType<T extends object>(type: string, cls: Class<T>, opts?: CompOptions): TypeClass<T> {
  if (opts?.override) {
    const n = normalizeType(type);
    for (const ctx of getContextsForType(n)) unregister(n, ctx);
  }

  const compClass = cls as TypeClass<T>;
  compClass.$type = normalizeType(type);
  // Bracket access in treeChain: proxy[Counter] → Proxy.get(_, "§app.counter")
  (cls as any)[Symbol.toPrimitive] = () => `§${compClass.$type}`;
  register(type, 'class', cls, opts);
  trackType(compClass.$type);

  // Per-action needs from static property on class
  const staticNeeds = (cls as any).needs as Record<string, string[]> | undefined;
  if (staticNeeds) {
    for (const [action, patterns] of Object.entries(staticNeeds)) {
      registerActionNeeds(type, action, patterns);
    }
  }

  // opts.needs = global fallback ('*') for all actions
  if (opts?.needs) registerActionNeeds(type, '*', opts.needs);

  const proto = cls.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    if (typeof proto[name] === 'function') {
      const meta: Record<string, unknown> = { ...opts?.ports?.[name] };
      if (opts?.noOptimistic?.includes(name)) meta.noOptimistic = true;
      if (proto[name] instanceof AsyncGenFn) meta.stream = true;

      register(type, `action:${name}`, (ctx: any, data: unknown) => {
        const target = ctx.comp ?? ctx.node;
        if (_als) return _als.run(ctx, () => proto[name].call(target, data, ctx.deps));
        _ctx = ctx;
        try { return proto[name].call(target, data, ctx.deps); }
        finally { _ctx = null; }
      }, Object.keys(meta).length ? meta : undefined);
    }
  }
  return compClass;
}

// Register server-only actions from a class. _ prefixed = internal (hidden from clients).
export function registerActions<T>(type: TypeId, cls: Class<T>, opts?: CompOptions): void {
  const t = normalizeType(type);
  const proto = cls.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    if (typeof proto[name] === 'function') {
      const context = `action:${name}`;
      const meta: Record<string, unknown> = { ...opts?.ports?.[name] };
      if (opts?.noOptimistic?.includes(name)) meta.noOptimistic = true;
      if (proto[name] instanceof AsyncGenFn) meta.stream = true;
      if (opts?.override) unregister(t, context);

      register(t, context, (ctx: any, data: unknown) => {
        const target = ctx.comp ?? ctx.node;
        if (_als) return _als.run(ctx, () => proto[name].call(target, data, ctx.deps));
        _ctx = ctx;
        try { return proto[name].call(target, data, ctx.deps); }
        finally { _ctx = null; }
      }, Object.keys(meta).length ? meta : undefined);
    }
  }
}

// ── Type-safe component access ──

export function setComponent<T>(node: NodeData, cls: Class<T>, data: Partial<Raw<T>>, field?: string): void {
  const comp = getComponent(node, cls, field);
  if (comp) {
    Object.assign(comp as object, data);
  } else {
    const $type = normalizeType(cls);
    const name = field ?? $type.split('.').at(-1)!;
    if (node[name]) throw new Error(`Component ${name} already exists on ${node.$path}`);
    node[name] = newComponent<T>(cls, data);
  }
}

export function newComponent<T>(cls: Class<T>, data: Partial<Raw<T>>): ComponentData<T> {
  const $type = normalizeType(cls);
  return Object.assign({ $type }, data, { $type }) as ComponentData<T>;
}

// Get default field values for a type: class instance fields → schema defaults → {}
export function getDefaults<T = any>(type: TypeId<T>): Partial<Raw<T>> {
  type R = Partial<Raw<T>>;

  // 1. Try registered class — new Class() gives field initializers
  const cls = resolve(type, 'class');
  if (cls) {
    const inst = new cls();
    return Object.assign({}, inst) as R;
  }

  // 2. Fall back to JSON schema defaults
  const schemaHandler = resolve(type, 'schema');
  if (schemaHandler) {
    const schema = schemaHandler() as Partial<TypeSchema>;
    if (schema?.properties) {
      const out: Record<string, unknown> = {};
      for (const [k, prop] of Object.entries(schema.properties)) {
        if ('default' in prop) out[k] = prop.default;
      }
      return out as R;
    }
  }

  return {} as R;
}
