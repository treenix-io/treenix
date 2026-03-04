// Treenity Component Registration — between core and server
// registerType(type, cls) → stamps $type, registers class, auto-registers actions from methods

import { registerActionNeeds } from '#comp/needs';
import { type Class, ComponentData, getComponent, NodeData, normalizeType, register, resolve, type TypeId } from '#core';
import { trackType } from '#mod/tracking';
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
    class: Class<unknown>;
  }
}

// ── Action context for class methods ──
// Set globally before method call, retrieved with getCtx() on the first line.
// JS is single-threaded: between setting _ctx and the method's first sync line,
// nothing can interleave — so getCtx() always captures the right context.

let _ctx: ExecCtx | null = null;

export type ExecCtx = { node: NodeData; store: Tree; signal: AbortSignal; [k: string]: unknown };

export function getCtx(): ExecCtx {
  if (!_ctx) throw new Error('getCtx(): called outside action context');
  return _ctx;
}

// ── Registration ──

// Port declaration: which component fields an action reads (pre) and writes (post).
// Stored as registry meta on action:* contexts. Queried via comp/ports.ts and comp/planner.ts.
export type PortDecl = { pre?: string[]; post?: string[] };
type CompOptions = { needs?: string[]; ports?: Record<string, PortDecl> };

export function registerType<T>(type: string, cls: Class<T>, opts?: CompOptions): TypeClass<T> {
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
      register(type, `action:${name}`, (ctx: any, data: unknown) => {
        const target = ctx.comp ?? ctx.node;
        _ctx = ctx;
        const result = proto[name].call(target, data, ctx.deps);
        _ctx = null;
        return result;
      }, opts?.ports?.[name]);
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
      register(t, `action:${name}`, (ctx: any, data: unknown) => {
        const target = ctx.comp ?? ctx.node;
        _ctx = ctx;
        const result = proto[name].call(target, data, ctx.deps);
        _ctx = null;
        return result;
      }, opts?.ports?.[name]);
    }
  }
}

// ── Type-safe component access ──

// Alias for getComponent (unified in L0)
export { getComponent as getComp };

export function setComp<T>(node: NodeData, cls: Class<T>, data: Partial<Raw<T>>, field?: string): void {
  const comp = getComponent(node, cls, field);
  if (comp) {
    Object.assign(comp as object, data);
  } else {
    const $type = normalizeType(cls);
    const name = field ?? $type.split('.').at(-1)!;
    if (node[name]) throw new Error(`Component ${name} already exists on ${node.$path}`);
    node[name] = newComp<T>(cls, data);
  }
}

export function newComp<T>(cls: Class<T>, data: Partial<Raw<T>>): ComponentData<T> {
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
    const schema = schemaHandler() as { properties?: Record<string, { default?: unknown }> };
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
