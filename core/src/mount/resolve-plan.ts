// Mount resolver → ReadPlan — Layer 4
// Translates a request path + caller-supplied query into the safe-list
// ReadPlan consumed by `executeList`. When the requested path is a query
// mount, the mount's trusted `{source, match}` config becomes
// `{source, viewWhere}` and the caller query becomes `callerWhere`. For
// non-mount paths the source IS the path; mountDeps stays empty since no
// mount/config write can invalidate this read.

import type { Tree } from '#tree';
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
  const mountDeps = new Set<string>();
  const node = await rawStore.get(path, ctx);
  mountDeps.add(path);

  const mountComp = node ? activeMount(node) : undefined;
  if (mountComp && mountComp.$type === 't.mount.query') {
    const mount = mountComp as { $type: string; source: string; match: Record<string, unknown> };
    if (typeof mount.source !== 'string' || !mount.source) {
      throw new Error(`Query mount at ${path} missing source`);
    }
    const match = mount.match ?? {};
    return {
      plan: {
        source: mount.source,
        viewWhere: match,
        ...(callerWhere ? { callerWhere } : {}),
      },
      mountDeps,
    };
  }

  return {
    plan: {
      source: path,
      ...(callerWhere ? { callerWhere } : {}),
    },
    mountDeps,
  };
}
