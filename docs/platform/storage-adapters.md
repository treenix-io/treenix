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

### Watching external writes (change streams)

To make manual mongo writes — migrations, other apps sharing the DB, ad-hoc `db.nodes.updateOne()` from a shell — reach SSE clients reactively, opt into change streams on the mount:

```json
{
  "$type": "t.mount.mongo",
  "uri": "mongodb://localhost:27017/?replicaSet=rs0",
  "db": "treenix",
  "collection": "nodes",
  "watch": true
}
```

- **`watch: false` (default)** — adapter does NOT subscribe to change streams. Only in-pipeline writes (via `tree.set/patch/remove`) reach clients. Zero extra Mongo load.
- **`watch: true`** — adapter calls `col.watch()` with `fullDocument: 'updateLookup'` and tries to enable `changeStreamPreAndPostImages` (best-effort `collMod`; needs admin perm). Out-of-band writes flow into the subscription bus and reach SSE clients. By default every event is forwarded, including change-stream echoes of writes Treenix itself performed (idempotent on the client side, ~2× event volume per write).
- **`dedupWindowMs: 0` (default)** — set to a positive value (e.g. `5000`) to enable best-effort self-write dedup. **Comes with a documented race window**: under `remove → recreate` sequences a delayed change-stream echo of the old remove can transiently delete the recreated node on clients. See [Mounts → dedup window](../concepts/mounts.md#dedup-window--picking-a-value) for the full trade-off.

**Requirements:**
- Mongo deployed as a replica set (`--replSet`). Single-node `mongod` cannot expose change streams. A 1-node replica set is fine for development: `docker run -d -p 27017:27017 mongo:7 --replSet rs0` then `mongosh --eval 'rs.initiate()'`.
- Mongo 6.0+ for full delete-event support (pre-images carry the deleted document's path). Without pre-images, delete events surface as `reconnect{preserved:false}` and clients refetch — still correct, just heavier.

**Limitations:**
- `update` events arrive as full-document `set` (via `updateLookup`), not derived `patch`. Larger wire payload than in-pipeline patches. Future optimization: map `updateDescription` to `PatchOp[]`.
- The `notify-keyspace-events`-style server-side filtering by path is not pushed down — runExternalWatch filters client-side after mapping. Fine for typical mount sizes; consider a `$match` pipeline if hot.

See [Mounts → Observing external writes](../concepts/mounts.md#observing-external-writes--treewatch--change-streams) for the general mechanism and how to add the same to a custom adapter.

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
