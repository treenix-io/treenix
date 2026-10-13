import { actionMethods, AsyncGenFn, compileNeeds, type Class, type CompOptions as NativeCompOptions, type ExecCtx, type TypeClass } from '../comp/index';
import { runWithExecCtx } from '../comp/context';
import type { NeedSpec } from '../comp/needs';
import { normalizeType, type TypeId } from '../core/component';
import { getContextsForType, register, unregister } from './legacy-registry';

export * from '../comp/index';

export type PortDecl = { pre?: string[]; post?: string[] };
export type CompOptions<T> = NativeCompOptions<T> & { ports?: Record<string, PortDecl>; override?: boolean };

type ActionExecCtx = ExecCtx & { comp?: object; deps?: unknown };

export type ActionMethod = { name: string; method: (...args: any[]) => unknown };

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

    const handler = (ctx: ActionExecCtx, data: unknown) => {
      const target = ctx.comp ?? ctx.node;
      return runWithExecCtx(ctx, () => method.call(target, data, ctx.deps));
    };
    register(normalizedType, context, handler, Object.keys(meta).length ? meta : undefined);
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

  const compClass = Object.assign(cls, { $type: normalizeType(type) });
  register(type, 'class', cls, opts);

  registerMethods(type, cls, opts, methods, needs);
  return compClass;
}

// Register server-only actions from a class. _ prefixed = internal (hidden from clients).
export function registerActions<T>(type: TypeId, cls: Class<T>, opts?: CompOptions<T>): void {
  registerMethods(type, cls, opts);
}

