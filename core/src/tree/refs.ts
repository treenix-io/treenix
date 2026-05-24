// withRefIndex — tree combinator that auto-populates $refs on set()
// Scans node fields for { $ref } entries, builds $refs array.
// Standalone refs (no f:) pass through untouched.

import { isRef, type NodeData, type RefEntry } from '#core';
import { applyOps, hasMutationOps, type PatchOp, type Tree } from '#tree';

/** Deep-scan node for $ref fields, return derived RefEntries */
function extractRefs(node: NodeData): RefEntry[] {
  const refs: RefEntry[] = [];

  function scan(obj: unknown, prefix: string) {
    if (!obj || typeof obj !== 'object') return;
    if (isRef(obj)) {
      refs.push({ t: obj.$ref, f: prefix || undefined });
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) scan(obj[i], `${prefix}.${i}`);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('$')) continue;
      const path = prefix ? `${prefix}.${k}` : `#${k}`;
      scan(v, path);
    }
  }

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    scan(v, `#${k}`);
  }

  return refs;
}

/** Merge derived refs with standalone refs (those without f:) */
function buildRefs(node: NodeData): RefEntry[] | undefined {
  const derived = extractRefs(node);
  const standalone = node.$refs?.filter(r => !r.f) ?? [];
  const merged = [...standalone, ...derived];
  return merged.length ? merged : undefined;
}

export function withRefIndex(inner: Tree): Tree {
  return {
    ...inner,

    // Pure passthrough — refs index doesn't transform watch.
    ...(inner.watch ? { watch: inner.watch.bind(inner) } : {}),

    async set(node, ctx) {
      const refs = buildRefs(node);
      if (refs) node.$refs = refs;
      else delete node.$refs;
      return inner.set(node, ctx);
    },

    async patch(path, ops, ctx) {
      // Compute $refs from patched state, then do a single atomic write
      const current = await inner.get(path, ctx);
      if (!current) return inner.patch(path, ops, ctx); // let inner throw "not found"

      const clone = structuredClone(current);
      applyOps(clone as Record<string, unknown>, ops);
      if (!hasMutationOps(ops)) return;
      const newRefs = buildRefs(clone);

      // Append $refs op last — wins over any user-supplied $refs patch
      const refsOp: PatchOp = newRefs ? ['r', '$refs', newRefs] : ['d', '$refs'];
      return inner.patch(path, [...ops, refsOp], ctx);
    },
  };
}
