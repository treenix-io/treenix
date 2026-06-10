// Mount resolver → ReadPlan — Layer 4
// Translates a request path + caller-supplied query into the safe-list
// ReadPlan consumed by `executeList`. When the requested path is a query
// mount, the mount's trusted `{source, match}` config becomes
// `{source, viewWhere}` and the caller query becomes `callerWhere`. For
// non-mount paths the source IS the path; mountDeps stays empty since no
// mount/config write can invalidate this read.

import { getComponentByName, isComponent } from '#core';
import type { Tree } from '#tree';
import type { ReadPlan } from '#tree/read-runtime';

export type ResolvedReadPlan = {
  plan: ReadPlan;
  /** Paths consulted during resolution. Stage-6 watch invalidation uses this
   *  to scope mount/config-write invalidations — writes to a path in this
   *  set invalidate ONLY handles that consulted it. */
  mountDeps: Set<string>;
  /** For legacy CDC matrix / subscription path that still wants the query
   *  mount metadata propagated back to the page result. Stage-6 watchQuery
   *  consumes the plan directly and this field goes away. */
  legacyQueryMount?: { source: string; match: Record<string, unknown> };
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

  const mountComp = node ? getComponentByName(node, 'mount') : undefined;
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
      legacyQueryMount: { source: mount.source, match },
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
