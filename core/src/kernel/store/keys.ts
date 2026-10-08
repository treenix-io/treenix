// ── $ ↔ _ key mapping (D06: Mongo/sift storage compat) ──
// $-prefixed system keys ($path, $type, $acl, ...) become _-prefixed for
// storage: Mongo forbids $-keys, and sift queries are pre-mapped by
// `mapSiftQuery`, so nodes must match the same form. Layer-1 concern —
// lived in core/component.ts until 2026-07 (core-tbcn).

// fromEntries keeps a `__proto__` field a field; assigning it would set the copy's prototype, and a query would
// read its contents as the node's own fields. The reverse mapping never yields that key.
export function toStorageKeys(node: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).map(([k, v]) => {
    // $id maps to _tid (treenix id), NOT _id — Mongo's immutable primary key
    // (D06: _id is skipped on read; the generic mapping would swallow identity).
    if (k === '$id') return ['_tid', v];
    return [k.startsWith('$') ? `_${k.slice(1)}` : k, v];
  }));
}

export function fromStorageKeys(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') continue;
    if (k === '_tid') { out['$id'] = v; continue; }
    out[k.startsWith('_') ? `$${k.slice(1)}` : k] = v;
  }
  return out;
}

export function mapNodeForSift(node: object): Record<string, unknown> {
  return toStorageKeys(node);
}
