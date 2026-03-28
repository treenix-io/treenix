// OnChange: typed partial with dot-notation → MutationOp[]
// Pure types + conversion utilities. No React dependency.

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

// ── mergeToOps: partial object → MutationOp[] ──

function validateDotKey(k: string): boolean {
  if (!k.includes('.')) return true;
  const segs = k.split('.');
  return segs.every(s => s.length > 0 && !/^\d+$/.test(s));
}

export function mergeToOps(partial: Record<string, unknown>): MutationOp[] {
  const ops: MutationOp[] = [];
  for (const [k, v] of Object.entries(partial)) {
    if (k.startsWith('$')) continue;
    if (!validateDotKey(k)) continue;
    if (v === undefined) ops.push(['d', k] as const);
    else ops.push(['r', k, v] as const);
  }
  return ops;
}

// ── mergeIntoNode: optimistic local merge ──

export function mergeIntoNode<T extends Record<string, unknown>>(node: T, partial: Record<string, unknown>): T {
  const merged = { ...node };
  for (const [k, v] of Object.entries(partial)) {
    if (k.startsWith('$')) continue;
    if (v === undefined) { delete merged[k]; continue; }
    if (k.includes('.') && validateDotKey(k)) {
      setByPath(merged, k, v);
    } else if (!k.includes('.')) {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged as T;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = cur[parts[i]];
    if (existing == null || typeof existing !== 'object') {
      cur[parts[i]] = {};
    } else {
      cur[parts[i]] = { ...(existing as Record<string, unknown>) };
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
