// Shared typed proxy factory — L0, no server deps.
// Used by: server (serverNodeHandle), client (createNodeClient), React (hooks).

import { type Class, type TypeProxy } from './index';
import { getComponent, normalizeType } from '#core';

export type ExecuteInput = {
  path: string;
  type?: string;
  key?: string;
  action: string;
  data?: unknown;
};
export type ExecuteFn = (input: ExecuteInput) => Promise<unknown>;
export type StreamFn = (input: ExecuteInput) => AsyncIterable<unknown>;

// kriz: what is the type?
const AsyncGenFn = Object.getPrototypeOf(async function* () {}).constructor;

/** Create TypeProxy from node data + class. Actions call execute/stream, fields read from comp. */
export function makeTypedProxy<T extends object>(
  node: Parameters<typeof getComponent>[0] | undefined,
  cls: Class<T>,
  path: string,
  execute: ExecuteFn,
  stream?: StreamFn,
  key?: string,
): TypeProxy<T>;
export function makeTypedProxy(
  node: Parameters<typeof getComponent>[0] | undefined,
  cls: Class<object>,
  path: string,
  execute: ExecuteFn,
  stream?: StreamFn,
  key?: string,
): object {
  const type = normalizeType(cls);
  const comp = node ? getComponent(node, cls, key) : undefined;

  return new Proxy(comp ?? {}, {
    get: (_t, prop: string) => {
      const fn = Reflect.get(cls.prototype, prop);
      if (typeof fn === 'function') {
        // kriz: what if it is AsyncGenFn, but no stream present?
        if (stream && fn instanceof AsyncGenFn)
          return (data?: unknown) => stream({ path, type, key, action: prop, data });
        return (data?: unknown) => execute({ path, type, key, action: prop, data });
      }
      return comp === undefined ? undefined : Reflect.get(comp, prop);
    },
  });
}
