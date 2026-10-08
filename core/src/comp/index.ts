// Treenix Component Registration — between core and server
// registerType(type, cls) → stamps $type, registers class, auto-registers actions from methods

import { parseNeeds, type NeedSpec } from '#comp/needs';
import { CtxUnavailableError, currentExecCtx, runWithExecCtx, type ExecCtx } from '#comp/context';
import {
  type Class,
  ComponentData,
  getComponent,
  getContextsForType,
  compKey,
  NodeData,
  normalizeType,
  register,
  resolve,
  type TypeId,
  unregister,
} from '#core';
import { trackType } from '#mod/tracking';
import { type TypeSchema } from '#schema/types';

export type { Class };
export type TypeClass<T> = Class<T> & {
  $type: string;
};

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

export type { ExecCtx };
export { CtxUnavailableError, predictionCtx } from '#comp/context';

export function getCtx(): ExecCtx {
  const ctx = currentExecCtx();
  if (!ctx) throw new CtxUnavailableError('getCtx(): called outside action context');
  return ctx;
}

// ── Registration ──

// Port declaration: which component fields an action reads (pre) and writes (post).
// Stored as registry meta on action:* contexts. Queried via comp/ports.ts and comp/planner.ts.
// kriz: what is port, why is in core?
export type PortDecl = { pre?: string[]; post?: string[] };
type ActionName<T> = Extract<{
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T], string>;
export type CompOptions<T> = {
  needs?: Partial<Record<ActionName<T> | '*', readonly string[]>>;
  ports?: Record<string, PortDecl>;
  override?: boolean;
  noOptimistic?: string[];
};
export const AsyncGenFn = Object.getPrototypeOf(async function* () { }).constructor;

type ActionExecCtx = ExecCtx & { comp?: object; deps?: unknown };

export type ActionMethod = { name: string; method: (...args: any[]) => unknown };

export function actionMethods<T>(cls: Class<T>): ActionMethod[] {
  const proto = cls.prototype;
  const methods: ActionMethod[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const method = Object.getOwnPropertyDescriptor(proto, name)?.value;
    if (typeof method === 'function') methods.push({ name, method });
  }
  return methods;
}

export function compileNeeds<T>(methods: ActionMethod[], opts?: CompOptions<T>): Map<string, NeedSpec[]> {
  const declared = opts?.needs;
  if (!declared) return new Map();

  const names = new Set(methods.map(({ name }) => name));
  for (const name of Object.keys(declared)) {
    if (name !== '*' && !names.has(name)) {
      throw new Error(`needs declared for missing action "${name}"`);
    }
  }

  const compiled = new Map<string, NeedSpec[]>();
  for (const { name } of methods) {
    const patterns = declared[name as ActionName<T>] ?? declared['*'];
    if (patterns) compiled.set(name, parseNeeds(patterns));
  }
  return compiled;
}

function registerMethods<T>(
  type: TypeId,
  cls: Class<T>,
  opts: CompOptions<T> | undefined,
  methods = actionMethods(cls),
  needs = compileNeeds(methods, opts),
): void {
  const normalizedType = normalizeType(type);
  for (const { name, method } of methods) {

    const context = `action:${name}`;
    const meta: Record<string, unknown> = { ...opts?.ports?.[name] };
    const actionNeeds = needs.get(name);
    if (actionNeeds) meta.needs = actionNeeds;
    if (opts?.noOptimistic?.includes(name)) meta.noOptimistic = true;
    if (method instanceof AsyncGenFn) meta.stream = true;
    if (opts?.override) unregister(normalizedType, context);

    register(normalizedType, context, (ctx: ActionExecCtx, data: unknown) => {
      const target = ctx.comp ?? ctx.node;
      return runWithExecCtx(ctx, () => method.call(target, data, ctx.deps));
    }, Object.keys(meta).length ? meta : undefined);
  }
}

export function registerType<T extends object>(type: string, cls: Class<T>, opts?: CompOptions<T>): TypeClass<T> {
  // Compile registration metadata before publishing any registry entries.
  const methods = actionMethods(cls);
  const needs = compileNeeds(methods, opts);
  if (opts?.override) {
    const n = normalizeType(type);
    // kriz: why unregister ALL contexts? and not only needed?
    for (const ctx of getContextsForType(n)) unregister(n, ctx);
  }

  const compClass = cls as TypeClass<T>;
  compClass.$type = normalizeType(type);
  register(type, 'class', cls, opts);
  trackType(compClass.$type);

  registerMethods(type, cls, opts, methods, needs);
  return compClass;
}

// Register server-only actions from a class. _ prefixed = internal (hidden from clients).
export function registerActions<T>(type: TypeId, cls: Class<T>, opts?: CompOptions<T>): void {
  registerMethods(type, cls, opts);
}

// ── Type-safe component access ──
// kriz: should full-rewrite component, not assign! add comments about this contract
// kriz: component type could change, or anything could change. let's discuss, and find the way.
// kriz: function like this should be like updateComponent, not set.
// kriz: so, let's discuss this set of functions
export function setComponent<T>(node: NodeData, cls: Class<T>, data: Partial<Raw<T>>, field?: string): void {
  const comp = getComponent(node, cls, field);
  if (comp) {
    Object.assign(comp as object, data);
  } else {
    const $type = normalizeType(cls);
    const key = compKey(field ?? $type.split('.').at(-1)!);
    if (node[key]) throw new Error(`Component ${key} already exists on ${node.$path}`);
    node[key] = newComponent<T>(cls, data);
  }
}
// kriz: this should be named makeComponent, like makeNode
export function newComponent<T>(cls: Class<T>, data: Partial<Raw<T>>): ComponentData<T> {
  const $type = normalizeType(cls);
  return Object.assign({ $type }, data, { $type }) as ComponentData<T>;
}

// Get default field values for a type: class instance fields → schema defaults → {}
// kriz: this should be somewhere near the schema.
// kriz: isn't schema should be preferred?
export function getDefaults<T = any>(type: TypeId<T>): Partial<Raw<T>> {
  // 1. Try registered class — new Class() gives field initializers
  const cls = resolve(type, 'class');
  if (cls) {
    const inst = new cls();
    return Object.assign({}, inst) as Partial<Raw<T>>;
  }

  // kriz: how will we resolve non-primitive types here?
  // 2. Fall back to JSON schema defaults
  const schemaHandler = resolve(type, 'schema');
  if (schemaHandler) {
    const schema = schemaHandler() as Partial<TypeSchema>;
    if (schema?.properties) {
      const out: Record<string, unknown> = {};
      for (const [k, prop] of Object.entries(schema.properties)) {
        if ('default' in prop) out[k] = prop.default;
      }
      return out as Partial<Raw<T>>;
    }
  }

  return {};
}
