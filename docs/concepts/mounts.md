---
title: Mounts
section: concepts
order: 7
description: Bring external systems into the tree — MongoDB, filesystems, remote instances, virtual views
tags: [core, architecture, integrations]
---

# Mounts

Bring existing systems into the [Tree](./tree.md) — MongoDB, filesystems, virtual views, custom adapters, or a remote Treenix instance. Reads and writes route through the adapter automatically.

```typescript
t.mount.mongo('/customers')
t.mount.fs('/notes')
t.mount.query('/orders/incoming')
t.mount.tree.trpc('/partner-org')
```

A mount is a [Node](./composition.md#node) with a `mount` component. Everything under its path is delegated to the adapter. To your application code, a mounted subtree is indistinguishable from local data — same `$path`, same [ACL](./security.md#acl), same [subscriptions](./reactivity.md).

## Built-in adapters

| Type | Purpose |
|---|---|
| `t.mount.mongo` | MongoDB collection |
| `t.mount.fs` | Local filesystem (files → nodes via codecs) |
| `t.mount.memory` | Volatile in-memory storage |
| `t.mount.overlay` | Layer two trees — reads cascade upward, writes hit the top |
| `t.mount.query` | Virtual view — filtered subset of another path |
| `t.mount.types` | Registry introspection — browse all registered [Types](./types.md) |
| `t.mount.mods` | The mod catalog as a tree |
| `t.mount.tree.trpc` | Another Treenix instance over tRPC |

Each adapter implements the same five-method [Tree interface](./tree.md). The only thing that changes is where data lives.

## How a mount resolves

```typescript
import { makeNode } from '@treenx/core'

await tree.set(makeNode('/db/orders', 'mount-point', {}, {
  mount: {
    $type: 't.mount.mongo',
    uri: 'mongodb://localhost:27017',
    db: 'shop',
    collection: 'orders',
  },
}))

await tree.get('/db/orders/123')
// → resolves through the mount, reads from MongoDB
// → returned with $path: '/db/orders/123', typed normally
```

The mount node is opaque from outside. You query the subtree, the mount resolves it, results come back as regular [Nodes](./composition.md#node).

## Overlay — read cascade, write to top

The default starter layout. Seed data lives below, runtime writes live above; the lower layer is never modified at runtime.

```json
{
  "mount": { "$type": "t.mount.overlay", "layers": ["base", "work"] },
  "base":  { "$type": "t.mount.fs", "root": "tree/seed" },
  "work":  { "$type": "t.mount.fs", "root": "tree/work" }
}
```

- **Read:** check `work` → fall back to `base`.
- **Write:** always to `work`.
- **Reset runtime state:** delete `tree/work/` and restart.

## Query — virtual filtered view

A query mount creates a virtual directory showing only nodes matching a filter. Nodes entering or leaving the filter automatically appear or disappear — no manual sync.

```typescript
await tree.set(makeNode('/orders/incoming', 'mount-point', {}, {
  mount: {
    $type: 't.mount.query',
    source: '/orders/data',
    match: { status: { value: 'incoming' } },
  },
}))

// useChildren('/orders/incoming') now shows only matching orders — live
```

The mechanism is called **CDC** (Change Data Capture) and is handled by the subscription system. See [Reactivity → CDC](./reactivity.md).

## Forest — mount another Treenix

Your tree can mount another instance's subtree over `t.mount.tree.trpc`. Remote Nodes look local; [ACL](./security.md#acl) stays at the boundary. This is the primitive behind [Federation](./roadmap.md#federation).

```
you.treenix.io/
├── /acme
└── /partner  ← t.mount.tree.trpc(globex.io)
```

Each side publishes exactly the subtrees it wants to expose. Everything else stays private behind policy. See [Composition → Forest](./composition.md#forest).

## Writing a custom mount

An adapter registers on the `mount` context. The handler receives the mount node (config) and a `ctx` with `parentStore` and related helpers, and returns a Tree implementation:

```typescript
import { register } from '@treenx/core'
import { registerType } from '@treenx/core'

export class MountRedis {
  url = ''
  namespace = ''
}
registerType('my.mount.redis', MountRedis)

register(MountRedis, 'mount', async (mount, ctx) => {
  const client = await connectRedis(mount.url)
  return {
    async get(path)         { /* ... */ },
    async getChildren(path) { /* ... */ },
    async set(node)         { /* ... */ },
    async remove(path)      { /* ... */ },
    async patch(path, ops)  { /* ... */ },
  }
})
```

The [Tree interface](./tree.md) is the whole contract — five methods. If your adapter implements them, it plugs in. Built-in adapters live in `engine/core/src/server/mount-adapters.ts` and make a good reference.

## Related

- [The Tree](./tree.md) — the five-method interface every mount implements
- [Composition → Forest](./composition.md#forest) — mounting another Treenix
- [Reactivity → CDC](./reactivity.md) — query-mount change tracking
- [Roadmap → Federation](./roadmap.md#federation) — production mounting between orgs
- Guide: [Federate Trees](../guides/mounts-federation.md) — full mount walkthrough
- [Platform → Storage Adapters](../platform/storage-adapters.md) — trade-offs between fs, mongo, memory
