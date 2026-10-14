// Component declarations and typed client action helpers.

import { parseNeeds, type NeedSpec } from '#comp/needs';
import { CtxUnavailableError, currentExecCtx, type ExecCtx } from '#comp/context';
import { type Class, ComponentData, getComponent, compKey, NodeData, normalizeType } from '#core';
import type { SecurityClass } from '#kernel/types';

export type { Class };
export type TypeClass<T> = Class<T> & {
  $type: string;
};

// Strip methods from a type — only keep data fields (recursive)
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type Raw<T> = {
  [K in keyof T as T[K] extends Function ? never : K]: T[K] extends (infer U)[]
    ? U extends object
      ? Raw<U>[]
      : T[K]
    : T[K] extends object
      ? Raw<T[K]>
      : T[K];
};

// Actions<T>: map class methods to typed async client signatures
// Uses Parameters<>/ReturnType<> to avoid TypeScript's "() => T extends (x: D) => T" false-match.
// Arity: retain the first argument's optionality and omit internal dependency arguments.
// Internal `deps` second-arg is absorbed by `...any[]` and dropped from client type.
// Generator methods (async *) → AsyncIterable<Y>; regular → Promise<R>
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type _AnyFn = (...args: any[]) => any;
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type _ToFn<T> = T extends _AnyFn ? T : never;

type _ActionArgs<T extends _AnyFn> =
  Parameters<T> extends []
    ? []
    : Parameters<T> extends [infer D, ...any[]]
      ? [data: D]
      : [data?: Parameters<T>[0]];

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type Actions<T> = {
  [K in keyof T as T[K] extends Function ? K : never]: (
    ...args: _ActionArgs<_ToFn<T[K]>>
  ) => ReturnType<_ToFn<T[K]>> extends AsyncGenerator<infer Y, any, any>
    ? AsyncIterable<Y>
    : Promise<Awaited<ReturnType<_ToFn<T[K]>>>>;
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

// ── Declarations ──

type ActionName<T> = Extract<
  {
    [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
  }[keyof T],
  string
>;
export type CompOptions<T> = {
  security?: SecurityClass;
  needs?: Partial<Record<ActionName<T> | '*', readonly string[]>>;
  noOptimistic?: string[];
};
export const AsyncGenFn = Object.getPrototypeOf(async function* () {}).constructor;

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

export function compileNeeds<T>(
  methods: ActionMethod[],
  opts?: CompOptions<T>,
): Map<string, NeedSpec[]> {
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

// ── Type-safe component access ──
// kriz: should full-rewrite component, not assign! add comments about this contract
// kriz: component type could change, or anything could change. let's discuss, and find the way.
// kriz: function like this should be like updateComponent, not set.
// kriz: so, let's discuss this set of functions
export function setComponent<T>(
  node: NodeData,
  cls: Class<T>,
  data: Partial<Raw<T>>,
  field?: string,
): void {
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
