## store (Tree)
Tree interface + adapters. Layer 1 — no deps except core types.

### Files
- index.ts — Tree interface, paginate, createMemoryTree, createOverlayTree, createFilterTree, resolveRef
- fs.ts — FS adapter (JSON files on disk), $rev OCC
- mimefs.ts — raw filesystem adapter with MIME/codec mapping
- cache.ts — cache wrapper over a Tree
- refs.ts — derived $refs index wrapper
- volatile.ts — memory overlay routing for volatile nodes
- validation.ts — schema validation wrapper
- migration.ts — read/write migration wrapper
- repath.ts — path prefix remapping wrapper
- query.ts — Query tree: virtual filtered view via sift (Mongo syntax). Used by t.mount.query
- patch.ts — compact PatchOp tuples and RFC 6902 conversion

### Conventions
- $rev: if present on incoming node → OCC check (match stored rev). If absent → blind upsert
- Empty and test-only patches validate but do not write or bump $rev
- Mongo: $ prefix → _ prefix transparently (toStorage/fromStorage)
- Tree composability: overlay(upper, lower), filter(upper, lower, predicate)
- Filesystem adapters must containment-check every path before read/write/readdir
