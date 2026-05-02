# jsonld-types — design docs

Architectural review, plans, and state for the `@treenx/jsonld-types` package.

## Status (paused 2026-05-02)

Plans #1 and #2 implemented and tested. Plans #3–#6 deferred.

| Plan | Status | Branch | Commits |
|---|---|---|---|
| #1 — core foundations (`replaceHandler` + sync-miss re-check in `resolve()`) | shipped to `engine/main` | — | 7 |
| #2 — lazy schema resolver pack (translator, slot validator, `loadSchemaOrgV29Pack`) | on `feature/jsonld-pack`, 11 commits, 27/27 tests, Codex score 9/10 | `feature/jsonld-pack` | 11 |
| #3 — `t.mount.jsonld` adapter + client schema fetch via `tree.get` | not started | — | 0 |
| #4 — UIX inheritance walker (parent class chain → view fallback) | not started | — | 0 |
| #5 — round-trip JSON-LD exporter/importer (D17 fragment IDs) | not started | — | 0 |
| #6 — `mods/ontology` migration to pack types | not started | — | 0 |

## Files

- [auto-review.md](./auto-review.md) — 4-round Codex architectural review log + post-loop refinement (lazy registration via `onResolveMiss`).
- [plan-01-core-foundations.md](./plan-01-core-foundations.md) — TDD plan for `replaceHandler` and sync-miss re-check (foundation for lazy resolvers, generally useful beyond JSON-LD).
- [plan-02-lazy-resolver.md](./plan-02-lazy-resolver.md) — TDD plan for the schema resolver pack, vendored snapshot, translator, slot validator, end-to-end validation.
- [review-state.json](./review-state.json) — final state of auto-review-loop (score 9, post-loop lazy refinement noted).

## Open architectural question (resume here)

The current Plan #2 implementation bundles a small vendored snapshot inside the package. For unknown-but-known types (classes that exist in schema.org but aren't in our vendored subset) the resolver returns `undefined` and validation silently degrades.

The intended Plan #3 architecture:

- Snapshots live on FS in `mods/jsonld/snapshots/` (vendored subset committed; full vocab cached after first need; URL fetch as fallback).
- `t.mount.jsonld` adapter exposes them via `/sys/types/jsonld/<vocab>/`, parses lazily on `tree.get`.
- Server-side `types-mount.get()` triggers `resolve(type, 'schema')` so the pack's miss resolver fires; the resulting registered schema is synthesized into the type node.
- Client-side `onResolveMiss('schema', ...)` calls `tree.get('/sys/types/...')` over tRPC, extracts the schema component, registers locally. UIX-style fetch+register pattern, but for `'schema'` instead of `'react'`.

Estimated effort to complete the full architecture (#3–#6): ~5–7 focused days. See plan files for TDD breakdown.
