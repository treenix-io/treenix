---
title: Go Realtime
section: guides
order: 6
description: React hooks, watch(), server-side subscriptions, optimistic patterns
tags: [guide, realtime, hooks]
---

# Go Realtime

[Reactivity](../concepts/reactivity.md) explains *why* Treenix streams every mutation to every subscriber. This guide is *how* you tap into that stream from React views, servers, and async loops.

## React: `usePath` and `useChildren`

The two hooks you'll use most. Both subscribe and re-render automatically.

```typescript
import { usePath, useChildren } from '@treenx/react/hooks'
import { Order } from './types'

const OrderView: View<Order> = ({ ctx }) => {
  // One node, reactive — Query<TypeProxy<Order>>
  const { data: order } = usePath(ctx!.node.$path, Order)

  // Its children, paginated + reactive
  const { data: items, total, hasMore, loadMore, loadingMore } =
    useChildren(ctx!.node.$path, {
      watch: true,       // re-render when existing children change
      watchNew: true,    // re-render when new children appear
      limit: 50,
    })

  return (
    <div>
      <h3>{order.status}</h3>
      <p>{items.length} of {total} items</p>
      {hasMore && (
        <button onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
```

`usePath(path, Class)` gives you a **TypeProxy** — reading fields subscribes them; calling methods routes through `execute`. `useChildren(path, opts)` returns a paged list with change tracking.

## Optimistic UX — write through `useActions`

Calls through `useActions(value).method()` apply optimistically on the client, then settle against the server's commit:

```typescript
const OrderCard: View<Order> = ({ value }) => {
  const actions = useActions(value)
  return (
    <button onClick={() => actions.advance()}>
      Advance → {value.status}
    </button>
  )
}
```

When the user clicks:

1. Local state flips to the next status — UI responds instantly.
2. Server validates, persists, emits a JSON Patch.
3. Other clients reconcile. Your client also reconciles against the committed patch.
4. If the server rejected (ACL, validation), local state rolls back.

You didn't write any of this glue. See [Type → Optimistic Update](../concepts/types.md#optimistic-update) for the pipeline.

## `watch()` — async iterator for non-React code

Outside React (scripts, services, CLI), iterate changes as they come:

```typescript
import { watch } from '@treenx/react/hooks'

for await (const value of watch('/sensors/temp')) {
  console.log('Temperature:', value)
}
```

The URI fragment syntax `#key` accesses a named component — `/sensor#config` reads the `config` component. Dot notation works for sub-fields: `/sensor#config.interval`.

## Server-side: `ctx.subscribe`

Inside a service, subscribe to a path and optionally its descendants:

```typescript
// Watch /orders AND all descendants
const unsub = ctx.subscribe('/orders', (event) => {
  switch (event.type) {
    case 'set':    console.log('Set:', event.path);    break
    case 'patch':  console.log('Patch:', event.path);  break
    case 'remove': console.log('Remove:', event.path); break
  }
}, { children: true })

// Exact path only — drop { children: true }
// const unsub = ctx.subscribe('/orders/alert', handler)

// Later: stop listening
unsub()
```

See [Reactivity — What flows on the stream](../concepts/reactivity.md) for the full event type reference.

## Services react to the tree

A [Service](../concepts/context.md#services) is a long-running handler pinned to a node. The pattern: subscribe when the service starts, unsubscribe in `stop()`.

```typescript
import { register } from '@treenx/core'
import { AlertWatcher } from './types'

register(AlertWatcher, 'service', async (value, ctx) => {
  const unsub = ctx.subscribe(value.watchPath, (event) => {
    if (event.type === 'patch') inspectAndMaybeAlert(event)
  }, { children: true })

  return { stop: async () => unsub() }
})
```

Lifecycle is handled for you — on server shutdown, Treenix calls `stop()` on active service handles.

See [Run Services](./services.md) for full service patterns.

## Query mounts update lists automatically

When you create a [query mount](../concepts/mounts.md), children change automatically as nodes enter or leave the filter:

```typescript
// Virtual folder: orders where status.value === 'incoming'
await tree.set(createNode('/orders/incoming', 'mount-point', {}, {
  mount: {
    $type: 't.mount.query',
    source: '/orders/data',
    match: { status: { value: 'incoming' } },
  },
}))
```

A `useChildren('/orders/incoming')` in any view gets the live filtered list — add, promote, or complete an order and the list reacts. The mechanism is [CDC](../concepts/reactivity.md) embedded in the subscription system; you don't wire it.

## Common patterns

### Debounced optimistic input

```typescript
const TitleInput: View<Bookmark> = ({ value }) => {
  const actions = useActions(value)
  const [draft, setDraft] = useState(value.title)

  useEffect(() => {
    const t = setTimeout(() => {
      if (draft !== value.title) actions.setTitle({ title: draft })
    }, 300)
    return () => clearTimeout(t)
  }, [draft])

  return <input value={draft} onChange={e => setDraft(e.target.value)} />
}
```

### Don't force re-render with dummy state

React Compiler optimizes away unused state. If you find yourself calling `setTick(t => t + 1)` to force re-renders, you're fighting the framework. Store meaningful state that the render actually reads.

## Related concepts

- [Reactivity](../concepts/reactivity.md) — the concept and event types
- [Type → Optimistic Update](../concepts/types.md#optimistic-update)
- [The Tree → Subscriptions](../concepts/tree.md#subscriptions)
- Guide: [Write React Views](./react-views.md)
- Guide: [Run Services](./services.md)
