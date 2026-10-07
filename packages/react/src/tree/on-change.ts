// OnChange: typed partial with dot-notation → MutationOp[]
// Types + conversion utilities. No React dependency.

import { isComponent, isSafeKey, type NodeData } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { $key, $node, stampComponent } from '#symbols';

export type MutationOp = ['r', string, unknown] | ['d', string];

// ── Typed dot-notation partial ──

/** Dot-paths for nested objects: { meta: { title: string } } → 'meta.title' (max 3 levels) */
type DotPaths<T, Prefix extends string = '', D extends unknown[] = []> =
  D['length'] extends 3 ? never
  : T extends object
    ? { [K in keyof T & string]:
        | `${Prefix}${K}`
        | DotPaths<T[K], `${Prefix}${K}.`, [...D, unknown]>
      }[keyof T & string]
    : never;

/** Get the type at a dot-path: DotValue<{ meta: { title: string } }, 'meta.title'> = string */
type DotValue<T, P extends string> =
  P extends `${infer K}.${infer Rest}`
    ? K extends keyof T ? DotValue<T[K], Rest> : never
    : P extends keyof T ? T[P] : never;

type TopLevel<T> = { [K in keyof T & string]?: T[K] | undefined };

type DotLevel<T> = {
  [P in DotPaths<T> as P extends `${string}.${string}` ? P : never]?: DotValue<T, P> | undefined;
};

/** What onChange accepts: top-level partial OR dot-notation paths, typed.
 *  undefined = delete field. Default T = untyped Record. */
export type OnChange<T = Record<string, unknown>> = TopLevel<Omit<T, `$${string}`>> & DotLevel<Omit<T, `$${string}`>>;

// ── scopeOnChange: prefix all keys for named component ──

export function scopeOnChange(onChange: (partial: OnChange) => void, key: string): (partial: OnChange) => void {
  return (partial) => {
    const scoped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(partial as Record<string, unknown>))
      scoped[`${key}.${k}`] = v;
    onChange(scoped);
  };
}

// ── Partial keys ──

// A key is a field or a dot-path into one. System fields change through their own verbs, a numeric segment
// would index an array the dot-path merge cannot address, and no key lies under another, so the ops of one
// partial do not depend on their order.
function assertPartialKeys(partial: Record<string, unknown>): void {
  for (const k of Object.keys(partial)) {
    if (k.startsWith('$')) throw new KernelError('INVALID', `onChange: ${k} is a system field`);

    for (const seg of k.split('.')) {
      if (seg === '' || /^\d+$/.test(seg) || !isSafeKey(seg)) throw new KernelError('INVALID', `onChange: bad segment in ${JSON.stringify(k)}`);
    }

    for (let i = k.indexOf('.'); i !== -1; i = k.indexOf('.', i + 1)) {
      if (Object.hasOwn(partial, k.slice(0, i))) throw new KernelError('INVALID', `onChange: ${k} lies under ${k.slice(0, i)}`);
    }
  }
}

// ── foldPartial: a later partial over an accumulated one ──

/** A key of `later` replaces the accumulated keys under it and writes into the accumulated key it lies under,
 *  so the result keeps no key under another. Neither argument is changed. */
export function foldPartial(acc: Record<string, unknown>, later: Record<string, unknown>): Record<string, unknown> {
  assertPartialKeys(later);
  const out = { ...acc };

  for (const [k, v] of Object.entries(later)) {
    for (const key of Object.keys(out)) if (key.startsWith(`${k}.`)) delete out[key];

    const owner = ownerKey(out, k);
    if (owner === undefined) out[k] = v;
    else out[owner] = withField(out[owner], k.slice(owner.length + 1).split('.'), v, k);
  }
  return out;
}

function ownerKey(acc: Record<string, unknown>, k: string): string | undefined {
  for (let i = k.indexOf('.'); i !== -1; i = k.indexOf('.', i + 1)) {
    if (Object.hasOwn(acc, k.slice(0, i))) return k.slice(0, i);
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// An undefined base is a pending delete of the owner; writing under it starts a fresh object.
function withField(base: unknown, segs: string[], value: unknown, key: string): Record<string, unknown> {
  if (base !== undefined && !isRecord(base)) {
    throw new KernelError('INVALID', `onChange: ${key} writes into a value that is not an object`);
  }

  const out: Record<string, unknown> = { ...base };
  const [head, ...rest] = segs;
  if (rest.length > 0) out[head] = withField(out[head], rest, value, key);
  else if (value === undefined) delete out[head];
  else out[head] = value;
  return out;
}

// ── mergeToOps: partial object → MutationOp[] ──

export function mergeToOps(partial: Record<string, unknown>): MutationOp[] {
  assertPartialKeys(partial);
  return Object.entries(partial).map(([k, v]): MutationOp => v === undefined ? ['d', k] : ['r', k, v]);
}

// ── mergeIntoNode: optimistic local merge ──

export function mergeIntoNode<T extends Record<string, unknown>>(node: T, partial: Record<string, unknown>): T {
  assertPartialKeys(partial);
  const merged = { ...node };
  for (const [k, v] of Object.entries(partial)) setByPath(merged, k, v);
  preserveContext(node, merged);
  return merged;
}

function preserveContext(source: object, target: Record<string, unknown>) {
  const owner = (source as any)[$node] as NodeData | undefined;
  if (!owner) return;
  stampComponent(target, owner, ((source as any)[$key] as string | undefined) ?? '');

  for (const [k, v] of Object.entries(target)) {
    if (k.startsWith('$') || !isComponent(v)) continue;
    if ((v as any)[$node] !== undefined) continue;
    stampComponent(v, owner, k);
  }
}

// undefined deletes the field, as the op it becomes does.
function setByPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = cur[parts[i]];
    if (existing == null || typeof existing !== 'object') {
      if (value === undefined) return;
      cur[parts[i]] = {};
    } else {
      const next = { ...(existing as Record<string, unknown>) };
      preserveContext(existing, next);
      cur[parts[i]] = next;
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  if (value === undefined) delete cur[leaf];
  else cur[leaf] = value;
}
