## store (Tree)
Tree interface + adapters. Layer 1 — no deps except core types.

### Файлы
- index.ts — Tree interface, paginate, createMemoryTree, createOverlayTree, createFilterTree, resolveRef
- mongo.ts — MongoDB adapter with $↔_ field mapping, $rev OCC (conditional replaceOne)
- fs.ts — FS adapter (JSON files on disk), $rev OCC
- query.ts — Query tree: virtual filtered view via sift (Mongo syntax). Used by t.mount.query

### Конвенции
- $rev: if present on incoming node → OCC check (match stored rev). If absent → blind upsert
- Mongo: $ prefix → _ prefix transparently (toStorage/fromStorage)
- Tree composability: overlay(upper, lower), filter(upper, lower, predicate)
