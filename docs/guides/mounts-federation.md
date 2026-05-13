---
title: Mounts & Federation
section: guides
order: 4
description: Connect external trees, delegate subtrees to different backends
tags: [guide, advanced]
---

# Mounts & Federation

Mounts let you delegate parts of the tree to different backends. Like Unix mount points — one unified namespace, multiple storage engines underneath.

## Basic Mount

A mount point is a node with a `mount` component. Everything under its path is handled by the mounted backend:

```typescript
import { makeNode } from '@treenx/core'

// Mount a MongoDB collection at /db/orders
await tree.set(makeNode('/db/orders', 'mount-point', {}, {
  mount: {
    $type: 't.mount.mongo',
    uri: 'mongodb://localhost:27017',
    db: 'shop',
    collection: 'orders',
  },
}))

// Now /db/orders/* reads from and writes to MongoDB
const order = await tree.get('/db/orders/123')
```

## Built-in Mount Types

### Filesystem

```typescript
makeNode('/docs', 'mount-point', {}, {
  mount: { $type: 't.mount.fs', root: 'data/docs' },
})
```

Maps a directory on disk to a tree path. Each node is a `$.json` file. The `fs-codec` system can also map other file formats (like `.md` files to `doc.page` nodes).

### Memory

```typescript
makeNode('/cache', 'mount-point', {}, {
  mount: { $type: 't.mount.memory' },
})
```

Volatile in-memory storage. Data lost on restart. Useful for caches, session data, temporary state.

### Overlay

```typescript
makeNode('/', 'metatron.config', {
  mount: { $type: 't.mount.overlay', layers: ['base', 'work'] },
  base: { $type: 't.mount.fs', root: 'tree/seed' },
  work: { $type: 't.mount.fs', root: 'tree/work' },
})
```

Reads check the upper layer (`work`) first, fall back to the lower layer (`base`). Writes always go to the upper layer. The lower layer is never modified at runtime.

This is the default setup in `root.json` — seed data in `tree/seed/` is read-only, runtime writes go to `tree/work/`.

### Query Mount

Virtual folder showing a filtered subset of another path:

```typescript
makeNode('/orders/incoming', 'mount-point', {}, {
  mount: {
    $type: 't.mount.query',
    source: '/orders/data',
    match: { status: { value: 'incoming' } },
  },
})
```

`getChildren('/orders/incoming')` returns only orders matching the filter. CDC events automatically add/remove nodes as they enter or leave the filter. No manual sync needed.

### Remote Tree (Federation)

Connect to another Treenix instance over tRPC:

```typescript
makeNode('/partner', 'mount-point', {}, {
  mount: {
    $type: 't.mount.tree.trpc',
    url: 'https://partner.example.com/trpc',
    token: '...',
  },
})
```

Everything under `/partner/*` is transparently proxied to the remote server. ACL, subscriptions, and actions all work across the federation boundary.

### Type Introspection

```typescript
makeNode('/sys/types', 'mount-point', {}, {
  mount: { $type: 't.mount.types' },
})
```

Exposes the registry as a read-only tree. Each registered type appears as a node with its schema.

## Writing a Custom Mount

Register a mount handler in the context system:

```typescript
import { register } from '@treenx/core'

register('my.adapter', 'mount', async (mount, ctx) => {
  // mount — the mount component data
  // ctx.parentStore — the tree that contains this mount point
  // ctx.globalStore — the root tree, when available

  // Return a Tree implementation
  return {
    async get(path) { /* ... */ },
    async getChildren(path, opts) { /* ... */ },
    async set(node) { /* ... */ },
    async remove(path) { /* ... */ },
    async patch(path, ops) { /* ... */ },
  }
})
```

Then create a mount point:

```typescript
makeNode('/external', 'mount-point', {}, {
  mount: {
    $type: 'my.adapter',
    apiKey: '...',
    endpoint: 'https://api.example.com',
  },
})
```

## root.json

The server's mount configuration lives in `root.json`:

```json
{
  "$path": "/",
  "$type": "metatron.config",
  "$acl": [
    { "g": "public", "p": 1 },
    { "g": "authenticated", "p": 9 },
    { "g": "admins", "p": 15 }
  ],
  "seeds": ["core"],
  "mount": { "$type": "t.mount.overlay", "layers": ["base", "work"] },
  "base": { "$type": "t.mount.fs", "root": "tree/seed" },
  "work": { "$type": "t.mount.fs", "root": "tree/work" }
}
```

The server reads this at startup: `tsx engine/core/src/server/main.ts root.json`

## Path Translation

When mounting remote trees, use `createRepathTree` to translate paths between local and remote namespaces:

```typescript
import { createRepathTree } from '@treenx/core/tree'

// Local mount at /partner/orders/* maps to remote /orders/*
const repathed = createRepathTree(remoteTree, '/partner/orders', '/orders')
// Requests to /partner/orders/123 translate to /orders/123 on the remote tree
```

## Related

- [Concepts: Tree](../concepts/tree.md) — the interface all mounts implement
- [Guide: Deployment](deployment.md) — production root.json configuration
