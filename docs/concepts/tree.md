---
title: Tree
section: concepts
order: 6
description: The universal data interface — five methods, pluggable storage, composable wrappers
tags: [core, beginner]
---

# Tree

The tree is Treenix's data interface. Every storage backend — memory, filesystem, MongoDB — implements the same five methods. You write code against the interface; swap the backend without changing application logic.

```typescript
interface Tree {
  get(path): Promise<NodeData | undefined>
  getChildren(path, opts?): Promise<Page<NodeData>>
  set(node): Promise<void>
  remove(path): Promise<boolean>
  patch(path, ops): Promise<void>
}
```

Five methods. That's the entire data layer.

## Basic Operations

```typescript
// Read
const node = await tree.get('/tasks/1')

// List children
const { items, total } = await tree.getChildren('/tasks', {
  limit: 50,
  offset: 0,
  depth: 1,        // 1 = direct children only (default)
})

// Write (create or update)
await tree.set(createNode('/tasks/2', 'todo.task', { title: 'New task' }))

// Delete
const existed = await tree.remove('/tasks/2')

// Patch (tuple ops: ['r', field, value] replace, ['d', field] delete)
await tree.patch('/tasks/1', [
  ['r', 'title', 'Updated title']
])
```

`Page<T>` is `{ items: T[], total: number }` — paginated results.

## Storage Adapters

Three built-in adapters:

### Memory

In-memory, volatile. Lost on restart. Fast.

```typescript
import { createMemoryTree } from '@treenx/core/tree'

const tree = createMemoryTree()
```

### Filesystem

JSON files on disk. Each node is a `$.json` file in a directory:

```
tree/seed/
  $.json              → root node
  tasks/
    $.json            → /tasks node
    buy-milk/
      $.json          → /tasks/buy-milk node
```

```typescript
import { createFsTree } from '@treenx/core/tree/fs'

const tree = await createFsTree('./tree/seed')
```

### MongoDB

Full-featured persistent store with OCC:

```typescript
import { createMongoTree } from '@treenx/mongo'

const tree = await createMongoTree('mongodb://localhost', 'mydb', 'nodes')
```

System fields `$path`, `$type`, `$acl` are stored as `_path`, `_type`, `_acl` in MongoDB (the `$` prefix conflicts with MongoDB operators). This conversion is transparent — you never see it in application code.

## Combinators

Trees compose. Wrap one tree with another to add behavior:

### Overlay

Reads check the upper layer first, writes go to the upper layer only. The lower layer provides defaults:

```typescript
import { createOverlayTree } from '@treenx/core/tree'

const tree = createOverlayTree(workTree, baseTree)
// Read: check work → fallback to base
// Write: always to work
// base is never modified at runtime
```

This is how the starter project works: `tree/work/` (writes) overlays `tree/seed/` (seed data).

### Filter

Route writes to different trees based on a predicate:

```typescript
import { createFilterTree } from '@treenx/core/tree'

const tree = createFilterTree(hotTree, coldTree, node => node.$type === 'hot')
// Nodes matching the predicate go to hotTree, rest to coldTree
```

## Mounts

Mounts delegate subtrees to different backends. Like Unix mount points:

```
/                    → filesystem (base + work overlay)
/db/orders           → MongoDB collection
/partner/api         → remote Treenix server via tRPC
/cache               → in-memory (volatile)
```

A mount is a node with a `mount` component:

```typescript
await tree.set(createNode('/db/orders', 'mount-point', {}, {
  mount: {
    $type: 't.mount.mongo',
    uri: 'mongodb://localhost:27017',
    db: 'shop',
    collection: 'orders',
  },
}))
```

Everything under `/db/orders/*` now reads from and writes to the MongoDB collection.

### Built-in mount types

| Type | Purpose |
|------|---------|
| `t.mount.fs` | Local filesystem |
| `t.mount.mongo` | MongoDB collection |
| `t.mount.memory` | In-memory (volatile) |
| `t.mount.overlay` | Layer two trees |
| `t.mount.query` | Virtual filtered view |
| `t.mount.tree.trpc` | Remote Treenix via tRPC |
| `t.mount.types` | Registry introspection |

### Query Mounts — virtual folders

A query mount creates a virtual directory showing a filtered subset of another path:

```typescript
await tree.set(createNode('/orders/incoming', 'mount-point', {}, {
  mount: {
    $type: 't.mount.query',
    source: '/orders/data',
    match: { status: { value: 'incoming' } },
  },
}))
// GET /orders/incoming → only orders where status.value === 'incoming'
```

Nodes entering or leaving the filter automatically appear/disappear. No manual sync.

## Server Pipeline

In production, the tree passes through several wrappers:

```
base tree (fs/mongo)
  → mounts (subtree delegation)
    → volatile (memory-only nodes)
      → validation (JSON Schema check on write)
        → subscriptions (realtime events + CDC)
```

Each layer adds behavior without modifying the core interface.

## Querying

`getChildren` supports MongoDB-style queries via the `query` option:

```typescript
const { items } = await tree.getChildren('/tasks', {
  query: { done: false, 'priority.level': 'high' },
  limit: 10,
})
```

Query syntax follows [sift](https://github.com/crcn/sift.js) — MongoDB operators like `$gt`, `$in`, `$regex` work.

## Subscriptions

Subscribe by exact path, or by prefix — every mutation streams as a JSON Patch to every subscriber. One primitive, two scopes.

In React, you rarely touch subscriptions directly. [`usePath`](../api/hooks.md#usepath) and [`useChildren`](../api/hooks.md#usechildren) wrap the subscription, keep a local cache fresh, and give you reactive state:

```typescript
import { usePath, useChildren } from '@treenx/react/hooks'
import { Task } from './types'

// One node — re-renders when any field on /tasks/buy-milk changes
const { data: task } = usePath('/tasks/buy-milk', Task)

// A subtree — re-renders when children are added, removed, or changed
const { data: tasks } = useChildren('/tasks', { watch: true, watchNew: true })
```

If you need the lower-level signal — the cache layer exposes `subscribePath` / `subscribeChildren` from `@treenx/react/tree/cache`. Each callback is invoked on change; you re-read the cache yourself. In application code, prefer the hooks. See [Reactivity](./reactivity.md) for the full mutation-to-subscriber flow.

## Related

- [Composition](./composition.md) — what's stored in the tree
- [Mounts](./mounts.md) — how subtrees get their storage
- [Reactivity](./reactivity.md) — the patch stream subscriptions deliver
- [Security → ACL](./security.md#acl) — access control on every tree operation
- Guide: [Federate Trees](../guides/mounts-federation.md) — connecting external trees
- Guide: [Go Realtime](../guides/go-realtime.md) — subscription patterns in React views
