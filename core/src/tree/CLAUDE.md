## store (Tree)
Tree interface + adapters. Layer 1 — no deps except core types.

### Files
- index.ts — Tree interface, paginate, createMemoryTree, createOverlayTree, createFilterTree, resolveRef
- fs.ts — FS adapter (JSON files on disk), $rev OCC
- mimefs.ts — raw filesystem adapter with MIME/codec mapping
- cache.ts — cache wrapper over a Tree (also used standalone by the client SDK)
- policy.ts — THE storage-policy step over the mounted tree: migration ($v ladders on read, example mod: mod/examples/versioned) → validation → $refs derivation → cache → trash (soft-delete into /sys/trash + GC sweep). Former separate wrappers, collapsed core-5fqq; $volatile routing cut with the feature (mem-only subtrees = t.mount.memory)
- refs.ts — the derived $refs index (RefEntry, refsOf) and the move tombstone (Moved, isMoved)
- repath.ts — path prefix remapping wrapper
- query.ts — Query tree: virtual filtered view via sift (Mongo syntax). Used by t.mount.query
- patch.ts — compact PatchOp tuples and RFC 6902 conversion

### Conventions
- $rev: if present on incoming node → OCC check (match stored rev). If absent → blind upsert
- Empty and test-only patches validate but do not write or bump $rev
- Mongo: $ prefix → _ prefix transparently (toStorage/fromStorage)
- Tree composability: overlay(upper, lower), filter(upper, lower, predicate)
- Filesystem adapters must containment-check every path before read/write/readdir
