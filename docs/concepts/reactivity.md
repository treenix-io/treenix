---
title: Reactivity
section: concepts
order: 6
description: Optimistic → commit → patch → observe — JSON Patches over a single SSE stream
tags: [core, realtime]
---

# Reactivity

Edit a node on one client — every subscriber sees the patch. Optimistic updates locally, eventual commit on the server, JSON Patch over the wire. No polling, no WebSocket setup, no manual refresh.

## The four-step pipeline

1. **Optimistic.** Client A calls an action — local state reflects the change immediately.
2. **Commit.** Server validates and emits a JSON Patch — server roundtrip.
3. **Patch.** Client B receives the patch and reconciles the same node live.
4. **Observe.** Subscribed [agents](./ai-mcp.md) see the same change through the same stream.

```
Client A              Server                Client B / Services / Agents
   │                     │                       │
   │ useActions(v).x() ─→│                       │
   │                     │ ← [Validation]       │
   │                     │ ← [Immer draft]      │
   │                     │ ← [Persist]          │
   │                     │ ← [Lineage]          │
   │                     │                       │
   │ ← JSON Patch ───── │ ── JSON Patch ────→  │
   │                     │                       │
   │ reconcile           │                       │ reconcile
```

The server maintains one SSE connection per client. Every subscription multiplexes over it. Only patches travel the wire — efficient, ordered, replayable.

## What flows on the stream

```typescript
type NodeEvent =
  | { type: 'set';       path: string; node: NodeData; addVps?: string[]; rmVps?: string[] }
  | { type: 'patch';     path: string; patches: Operation[]; addVps?: string[]; rmVps?: string[] }
  | { type: 'remove';    path: string; rmVps?: string[] }
  | { type: 'reconnect'; preserved: boolean }
```

- **`set`** — full node replaced (initial load, large update).
- **`patch`** — JSON Patch ops applied to the existing node (most common — small changes).
- **`remove`** — node deleted.
- **`reconnect`** — the SSE connection reopened. `preserved: true` means the server kept your subscription state; `false` means re-sync.

`addVps` / `rmVps` are **virtual path changes** — used by [query mounts](./mounts.md) when a node enters or leaves a filter (see CDC below).

## CDC — Change Data Capture

When a node changes, the subscription system checks every active query [mount](./mounts.md). If the node now passes a filter it didn't before, it virtually *appears* there. If it no longer passes, it virtually *leaves*.

```
/orders/incoming is a query mount: status === 'incoming'

Order /orders/123 changes from status:'incoming' → 'kitchen':
  event.rmVps = ['/orders/incoming/123']     // removed from virtual folder
  Client automatically removes it from any useChildren('/orders/incoming')
```

This happens on the server. The client just receives the normal stream — query mounts stay honest without extra code.

## In React — hooks do the work

You rarely call `subscribe` directly in React. `usePath` and `useChildren` wrap the subscription and give you reactive state:

```typescript
import { usePath, useChildren } from '@treenx/react'
import { OrderStatus } from './types'

function OrderView({ path }: { path: string }) {
  // Re-renders when the node changes — anywhere, by anyone
  const { data: order } = usePath(path, OrderStatus)

  // Re-renders when children change or new ones appear
  const { data: items } = useChildren(path, {
    watch: true,      // existing children
    watchNew: true,   // new children appearing
  })

  return <div>{order.status} — {items.length} items</div>
}
```

When anyone calls `useActions(value).advance()` — from this UI, from another tab, from MCP, from a cron service — every subscriber re-renders. Same tree, one stream.

For patterns (optimistic UX, pagination, watch(), server-side subscriptions), see the [Go Realtime](../guides/go-realtime.md) guide.

## Never poll

Treenix is reactive by default. There is no reason to use `setInterval` or periodic `fetch` for data that lives in the tree. If you catch yourself writing `setInterval(() => fetchData(), 5000)`, stop. Use `usePath`, `useChildren`, or `watch()`.

For data that *lives* outside the tree (third-party APIs, sensors), write a [service](./context.md#services) that pushes updates into the tree, then subscribe to the resulting nodes. The rest of the app only knows about the tree.

## Related

- [The Tree](./tree.md) — the data interface subscriptions run on
- [Type → Optimistic Update](./types.md#optimistic-update) — the client-side half of the loop
- [Mounts → Query mounts](./mounts.md) — how CDC is produced
- [Audit Trail](./audit.md) — the lineage each patch carries
- Guide: [Go Realtime](../guides/go-realtime.md) — hooks, watch(), server-side subscribe
- Guide: [Write React Views](../guides/react-views.md)
