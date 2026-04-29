---
title: Storage Adapters
section: platform
order: 3
description: memory, fs, mongo — what persists, what scales, when to pick which
tags: [platform, storage]
---

# Storage Adapters

Every [Mount](../concepts/mounts.md) plugs in via a storage adapter. Three ship out of the box; you can register more (see [custom mounts](../concepts/mounts.md)).

| Adapter | Persistence | Queries | Concurrency | Typical use |
|---|---|---|---|---|
| `t.mount.memory` | Volatile | In-memory | Single process | Tests, caches, session state, the live `/sys/types` registry |
| `t.mount.fs` | Disk (JSON/`.md`/custom codecs) | Linear scan | Single process | Seed data, git-tracked content, doc sites |
| `t.mount.mongo` | Persistent, clustered | Mongo query operators | Multi-process, OCC via `$rev` | Production runtime state |

Pick by the question "when the server restarts, what should survive?" and the secondary question "how do I want to search it?"

## `t.mount.memory`

Volatile in-memory tree. Zero dependencies, zero config. Useful for:

- **Tests** — instantiate, seed, assert, discard.
- **Caches and session state** — anything that should reset on restart.
- **Virtual subtrees** produced by live introspection (e.g. `t.mount.types` is memory-backed).

```typescript
import { createMemoryTree } from '@treenx/core/tree'
const tree = createMemoryTree()
```

Not for production data you can't re-seed.

## `t.mount.fs`

Files on disk, one node per `$.json` file in a directory layout that mirrors the tree. Codecs can map other file types — `doc/fs-codec` maps `.md` files to `doc.page` nodes, for example.

Shape on disk:

```
tree/seed/
  $.json                    → root node
  tasks/
    $.json                  → /tasks node
    buy-milk/
      $.json                → /tasks/buy-milk
```

Strengths:

- **Git-tracked.** Seed data lives in the repo; diffs are reviewable PRs.
- **Codec-friendly.** Rich content types round-trip through human-editable formats.
- **Simplest backup.** It's a directory — `tar`, `rsync`, done.

Trade-offs:

- **Linear queries** — `getChildren` with a filter walks files. Fine for ten thousand nodes; painful for millions.
- **Single-writer** — no multi-process OCC.

```typescript
import { createFsTree } from '@treenx/core/tree/fs'
const tree = await createFsTree('./tree/seed')
```

## `t.mount.mongo`

MongoDB collection. The production default. Supports:

- **Persistent storage** with replication and backups if your Mongo cluster does.
- **Rich queries** — Mongo operators `$gt`, `$in`, `$regex`, text indexes — exposed through `tree.getChildren({ query })`.
- **OCC via `$rev`** — concurrent writers detect conflicts.
- **Multi-process** — the API server and background services all point at the same Mongo.

```typescript
import { createMongoTree } from '@treenx/mongo'
const tree = await createMongoTree('mongodb://localhost', 'treenix', 'nodes')
```

In storage, `$` system fields become `_` to avoid collision with Mongo operators (`$path` → `_path`, `$acl` → `_acl`). Conversion is transparent.

## Common topologies

### Overlay — seed below, runtime above

The starter default. Seed lives in `tree/seed/` (git), runtime writes in `tree/work/` or in Mongo. Reads cascade upward, writes hit the top layer only. See [Mounts → Overlay](../concepts/mounts.md).

### All Mongo

Simplest production topology — one adapter, one source of truth. Seed data lives in an admin script, or in a sibling fs mount that's read-only.

### Hybrid per subtree

Mount different adapters at different paths: `/cache` on memory, `/docs` on fs (codec-backed), `/orders` on mongo, `/partner` on a remote Treenix over `t.mount.tree.trpc`.

```json
{
  "mount": { "$type": "t.mount.overlay", "layers": ["base", "work"] },
  "base":  { "$type": "t.mount.fs", "root": "tree/seed" },
  "work":  {
    "$type": "t.mount.mongo",
    "uri": "mongodb://localhost:27017",
    "db": "treenix",
    "collection": "nodes"
  }
}
```

Treat adapter choice per subtree, not per app.

## When to pick which

| Need | Adapter |
|---|---|
| Seed data in PRs | `t.mount.fs` |
| Production app state | `t.mount.mongo` |
| Tests, caches, volatile state | `t.mount.memory` |
| Filtered virtual folder | `t.mount.query` (see [Mounts](../concepts/mounts.md)) |
| Mirror a remote Treenix | `t.mount.tree.trpc` |
| Markdown/docs site | `t.mount.fs` with the doc codec |

## Related

- [Mounts](../concepts/mounts.md) — how adapters compose
- [The Tree](../concepts/tree.md) — the five-method interface they all implement
- [Deployment](./deployment.md) — `root.json` topology examples
- [Self-Hosting Checklist](./self-hosting.md) — backups per adapter
