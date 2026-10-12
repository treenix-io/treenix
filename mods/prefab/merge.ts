import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';

const absent = Symbol('absent');

/** Distinguish a removed property from a present value while comparing each field. */
function field(value: object, name: string): unknown {
  return Object.hasOwn(value, name) ? Reflect.get(value, name) : absent;
}

/** Select identity-based merging only for arrays whose objects all declare an id. */
function keyed(value: readonly unknown[]): Map<string | number, object> | undefined {
  const result = new Map<string | number, object>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const id: unknown = Reflect.get(item, 'id');
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    if (result.has(id)) throw new KernelError('INVALID', 'Prefab array contains duplicate ids');
    result.set(id, item);
  }
  return result;
}

/** Advance a base only where propagation actually writes the source value. */
function merge(
  current: unknown,
  base: unknown,
  source: unknown,
): { value: unknown; base: unknown } {
  if (isDeepStrictEqual(current, base)) return { value: source, base: source };

  if (Array.isArray(current) && Array.isArray(base) && Array.isArray(source)) {
    const own = keyed(current),
      previous = keyed(base),
      upstream = keyed(source);
    if (own !== undefined && previous !== undefined && upstream !== undefined) {
      const value: unknown[] = [],
        nextBase: unknown[] = [];
      for (const id of new Set([...own.keys(), ...upstream.keys(), ...previous.keys()])) {
        const next = merge(
          own.get(id) ?? absent,
          previous.get(id) ?? absent,
          upstream.get(id) ?? absent,
        );
        if (next.value !== absent) value.push(next.value);
        if (next.base !== absent) nextBase.push(next.base);
      }
      return { value, base: nextBase };
    }
    return { value: current, base };
  }

  if (
    current !== null &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    base !== null &&
    typeof base === 'object' &&
    !Array.isArray(base) &&
    source !== null &&
    typeof source === 'object' &&
    !Array.isArray(source)
  ) {
    const value: Record<string, unknown> = {},
      nextBase: Record<string, unknown> = {};
    for (const name of new Set([
      ...Object.keys(current),
      ...Object.keys(base),
      ...Object.keys(source),
    ])) {
      const next = merge(field(current, name), field(base, name), field(source, name));
      if (next.value !== absent) value[name] = next.value;
      if (next.base !== absent) nextBase[name] = next.base;
    }
    return { value, base: nextBase };
  }

  return { value: current, base };
}

/** Merge node fields without resetting the last propagated value of an override. */
export function mergeFields(
  current: Readonly<Record<string, unknown>>,
  base: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, unknown>>,
): { value: Record<string, unknown>; base: Record<string, unknown> } {
  const value: Record<string, unknown> = {},
    nextBase: Record<string, unknown> = {};
  for (const name of new Set([
    ...Object.keys(current),
    ...Object.keys(base),
    ...Object.keys(source),
  ])) {
    const next = merge(field(current, name), field(base, name), field(source, name));
    if (next.value !== absent) value[name] = next.value;
    if (next.base !== absent) nextBase[name] = next.base;
  }
  return { value, base: nextBase };
}
