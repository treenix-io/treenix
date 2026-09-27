// Mount resolver → ReadPlan — Layer 4
// Translates a request path + caller-supplied query into the safe-list
// ReadPlan consumed by `executeList`. When the requested path is a query
// mount, the mount's trusted `{source, match}` config becomes
// `{source, viewWhere}` and the caller query becomes `callerWhere`. For
// non-mount paths the source IS the path.

import type { Tree } from '#tree';
import { queryConfigOf } from '#tree/query';
import type { ReadPlan } from '#tree/read-runtime';
import { activeMount } from './index';

export type ResolvedReadPlan = {
  plan: ReadPlan;
  /** Paths consulted during resolution. Watch invalidation (Stage 6d) scopes
   *  mount/config-write invalidations by this set — writes to a path in it
   *  invalidate ONLY handles that consulted it. Always contains the request
   *  path itself. */
  mountDeps: Set<string>;
};

export async function resolveReadPlan(
  rawStore: Tree,
  path: string,
  callerWhere?: Record<string, unknown>,
  ctx?: unknown,
): Promise<ResolvedReadPlan> {
  const mountDeps = new Set<string>([path]);
  const node = await rawStore.get(path, ctx);
  const mount = node && activeMount(node);
  const caller = callerWhere ? { callerWhere } : {};

  if (mount?.$type === 't.mount.query') {
    const { source, match } = queryConfigOf(mount, path);
    return { plan: { source, viewWhere: match, ...caller }, mountDeps };
  }
  return { plan: { source: path, ...caller }, mountDeps };
}
