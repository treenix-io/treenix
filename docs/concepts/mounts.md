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

The [Tree interface](./tree.md) is the whole contract — five methods. If your adapter implements them, it plugs in. Built-in adapters live in `engine/core/src/mount/adapters.ts` and make a good reference.

## Observing external writes — `tree.watch` + change streams

Tree exposes an **optional** `watch?(scope, opts?)` method. When an adapter implements it, [Reactivity](./reactivity.md) can observe **out-of-band writes** — writes that bypass the Treenix pipeline (manual mongo writes, other apps sharing the DB, migrations, file edits in a watched directory).

Without `watch`, only writes that flow through `tree.set/patch/remove` reach SSE clients. With `watch`, the change source feeds the same subscription bus.

### Tree.watch contract

```typescript
watch?(
  scope: TreeWatchScope,        // { kind: 'all' } | { kind: 'path', path } | { kind: 'children', path }
  opts?: TreeWatchOpts,         // { signal?, buffer? }
): AsyncIterable<TreeEvent>     // { type: 'set' | 'patch' | 'remove' | 'reconnect', ... }
```

Lifecycle, back-pressure, and `reconnect{preserved:false}` semantics are pinned in [`engine/core/src/tree/watch.ts`](../../engine/core/src/tree/watch.ts). The `subscriptionToAsyncIterable` helper wraps any register/unregister callback into a contract-compliant AsyncIterable.

### Wiring an external watch into the subscription bus

The mount adapter receives `ctx.startExternalWatch` when the host pipeline supplies one (`createPipeline` does). Call it after creating the tree to forward external events into the subscription bus:

```typescript
register(MountRedis, 'mount', async (mount, ctx) => {
  const tree = await createRedisTree(mount.url)   // tree.watch implemented via Redis keyspace notifications

  if (tree.watch && mount.watch && ctx.startExternalWatch) {
    const pathPrefix = mount.shared ? '/' : ctx.path
    ctx.startExternalWatch(tree, {
      pathPrefix,                              // repath inner→outer namespace
      dedupWindowMs: mount.dedupWindowMs ?? 0, // default OFF — see warning below
      source: `redis@${ctx.path}`,             // for log lines
    })
  }

  return mount.shared ? tree : createRepathTree(tree, ctx.path, '/')
})
```

What `ctx.startExternalWatch` does under the hood ([`engine/core/src/sub/external-watch.ts`](../../engine/core/src/sub/external-watch.ts)):

1. **Subscribes** to `tree.watch({ kind: 'all' })` and drives a `for await` loop.
2. **Repaths** every event from inner namespace (`/foo`) to outer namespace (`/mountRoot/foo`) before forwarding.
3. **Invalidates the outer server cache** for the repathed path BEFORE forwarding the event. Without this step, downstream consumers (e.g. the ACL watch-filter doing `baseStore.get(path)` to compute claims on the event) would read the stale pre-write cached node. For `reconnect{preserved:false}` the entire cache is cleared.
4. **Dedups** writes that originated in-pipeline: `withSubscriptions` notifies via `onSelfWrite(path, rev)`; the consumer keeps a two-bucket TTL buffer keyed by `(type, path, rev)` and skips matches. Window is configurable per mount.
5. **Retries** with exponential backoff (`initialRetryMs` → `maxRetryMs`, default 1 s → 30 s) when the stream errors. Emits `reconnect{preserved:false}` before each retry so clients refetch. `WatchManager.notify` broadcasts `reconnect` events to every connected user.
6. **Lifecycle** — `withMounts` stores the abort fn on the mount cache entry. On any eviction (explicit invalidation via config change OR FIFO drop when `cacheMax` is reached), the bounded-cache `onEvict` callback fires the abort: change-stream cursor closes, dedup rotation timer clears, `onSelfWrite` subscription releases. Nothing leaks.

### Configuration fields convention

Adapters that gate external-watch on caller intent (most should, since change streams add cost) expose two fields on their mount class:

```typescript
export class MountRedis {
  url = ''
  /** Enable tree.watch via Redis keyspace notifications. Default OFF —
   *  requires notify-keyspace-events config on the Redis server. */
  watch = false
  /** Dedup TTL (ms) for self-write suppression. Default 0 = OFF (every
   *  external event forwarded, including echoes of in-pipeline writes —
   *  idempotent, ~2× event volume). Opt in (e.g. 5_000) when you accept the
   *  documented race window. See "Known limitations" below. */
  dedupWindowMs = 0
}
```

When `watch: false`, the adapter does NOT call `ctx.startExternalWatch` (and ideally does NOT expose `tree.watch` either). Callers get `tree.watch === undefined` — a `TypeError` at the call site if someone tries to consume it, never a silent stall.

### Dedup window — picking a value

**Default is `0` (OFF) — every external event is forwarded.** That includes change-stream echoes of writes Treenix itself performed (so each in-pipeline write triggers one immediate event from `withSubscriptions` and one ~lag-later echo from the external source). Idempotent on the client side; doubles event volume per write.

Turn on (`dedupWindowMs: N`) ONLY when you accept the documented race window:

- The dedup buffer is keyed by `(type, path, $rev)`. Set/patch echoes are reliably suppressed; **remove echoes are never deduped** because remove events have no `$rev` for identity.
- Under a `self-remove(/x) → self-recreate(/x)` sequence within the window, a delayed change-stream echo of the OLD remove arrives AFTER the recreate. The remove is forwarded (no dedup); the immediate set echo IS deduped. Client transiently sees `/x` deleted, but the next real read or invalidation restores correctness — visible glitch, no permanent corruption.
- Operation-identity dedup (preimage `$rev`, writer token) would close this — not implemented yet. Until then, prefer `0` for correctness-first apps and only opt in when SSE event volume is a measured bottleneck.

When enabled, effective TTL is `[dedupWindowMs, 2 * dedupWindowMs)` (two-bucket rotation). Typical values:

- **~1 s**: low-lag sources (in-process FS watcher, local socket).
- **~5 s**: typical replica-set DB lag (Mongo, Postgres logical replication).
- **~30 s**: cross-region replication, flaky networks, eventually-consistent stores.

### Built-in example: `t.mount.mongo`

See [`packages/mongo/src/index.ts`](../../engine/packages/mongo/src/index.ts) — `createMongoTree` exposes `watch?` when `opts.watch === true`, wires `col.watch()` change streams through `subscriptionToAsyncIterable`, handles Mongo-specific edge cases (pre-images for delete events, `invalidate`/`drop` → reconnect-and-close). The mount adapter for `t.mount.mongo` calls `ctx.startExternalWatch` exactly as shown above.

### Known limitations

- **CDC matrix bypass for external events.** Out-of-band writes invalidate the server cache and reach direct watchers via SSE, but they do NOT pass through `cdcEval`. Query mounts (`t.mount.query`) and other virtual-parent watchers will not see `addVps`/`rmVps`/`invalidateVps` for external writes — only direct path/children subscribers do. If you depend on query mounts reflecting external writes, the workaround today is to set `reconnect` semantics on clients (refetch on `reconnect{preserved:false}`) and rely on the runExternalWatch cache invalidation to make those refetches fresh.
- **Composite mounts do not propagate startExternalWatch.** `MountOverlay`, `createRepathTree`, and other combinators do not forward `ctx.startExternalWatch` to inner trees. A Mongo adapter wrapped inside an overlay or repath does NOT get its change stream wired into the bus. The current opt-in shape (`mount.watch: true` on the leaf `t.mount.mongo`) works only for direct mounts. Combinator propagation is on the roadmap (design-doc follow-ups A/B/C).
- **Self-write dedup race window.** When a write goes through `tree.set`, the dedup buffer marks `(path, $rev)` AFTER the storage write returns. A Mongo change-stream cursor can — in pathological timing — deliver the same event BEFORE the mark is installed, producing one duplicate event on clients. Idempotent on the client side; not a correctness bug, just a rare extra render.

## Related

- [The Tree](./tree.md) — the five-method interface every mount implements
- [Composition → Forest](./composition.md#forest) — mounting another Treenix
- [Reactivity → CDC](./reactivity.md) — query-mount change tracking
- [Roadmap → Federation](./roadmap.md#federation) — production mounting between orgs
- Guide: [Federate Trees](../guides/mounts-federation.md) — full mount walkthrough
- [Platform → Storage Adapters](../platform/storage-adapters.md) — trade-offs between fs, mongo, memory
