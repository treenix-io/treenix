import type { ModuleId, OpenRegistration } from './types';

/** Snapshot code declarations without sharing the caller's mutable entry collection. */
export function declareOpenModule<E extends OpenRegistration, T = never>(
  id: ModuleId,
  open: readonly E[],
  types?: readonly T[],
) {
  return Object.freeze({
    id,
    open: Object.freeze(open.map((entry) => Object.freeze({ ...entry }))),
    ...(types === undefined ? {} : { types: Object.freeze([...types]) }),
  });
}
