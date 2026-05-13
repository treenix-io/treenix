---
title: Actions
section: concepts
order: 4
description: Mutations through typed methods — Immer drafts, async, generators, validation
tags: [core, beginner]
---

# Actions

Actions are the only way to mutate data from outside the server. Never call `tree.set()` from client code — call `execute(path, action, data)` instead. Actions enforce business logic, run validation, and broadcast changes.

```typescript
execute('/orders/123', 'advance')
```

Under the hood:

1. Engine loads the node at `/orders/123`
2. Finds the `advance` method on the node's type class
3. Creates an Immer draft of the component
4. Calls `advance()` on the draft
5. Generates patches from the mutation
6. Checks `$rev` for optimistic concurrency conflicts
7. Persists and broadcasts to subscribers

## Defining Actions

Actions are methods on type classes. `registerType` discovers them automatically:

```typescript
import { registerType } from '@treenx/core'

export class OrderStatus {
  value: 'incoming' | 'kitchen' | 'ready' = 'incoming'

  advance() {
    if (this.value === 'incoming') this.value = 'kitchen'
    else if (this.value === 'kitchen') this.value = 'ready'
  }
}

registerType('order.status', OrderStatus)
// Automatically registers: action:advance
```

`this` is an Immer draft — mutate it directly. No need to return a new object.

## Actions with Arguments

Pass data through a typed `data` parameter:

```typescript
export class PultConfig {
  risk = 0.5

  setRisk(data: { value: number }) {
    this.risk = Math.max(0, Math.min(1, data.value))
  }
}
```

Call from the client:

```typescript
execute('/pult/config', 'setRisk', { value: 0.8 })
```

The argument type is extracted for JSON Schema generation — the Inspector shows typed input fields automatically.

## Calling Actions

### From React views

Use `usePath` with a type class to get a **TypeProxy** — reactive data + typed action methods:

```typescript
import { usePath } from '@treenx/react'
import { OrderStatus } from './types'

function OrderCard({ path }: { path: string }) {
  const { data: status } = usePath(path, OrderStatus)
  // status.value    — live data (reactive, re-renders on change)
  // status.advance() — calls execute() on the server, returns Promise

  return (
    <button onClick={() => status.advance()}>
      {status.value} →
    </button>
  )
}
```

### From server-side code

Use `serverNodeHandle` for typed access:

```typescript
import { serverNodeHandle } from '@treenx/core/server/actions'

const nc = serverNodeHandle(tree)
await nc('/orders/123').get(OrderStatus).advance()
```

### Low-level (MCP, generic tools)

```typescript
import { executeAction } from '@treenx/core/server/actions'

// By type (scans for matching component)
await executeAction(tree, '/orders/123', 'order.status', undefined, 'advance')

// By key (direct lookup)
await executeAction(tree, '/orders/123', 'order.status', 'status', 'advance')

// Node-level (action on the node's $type)
await executeAction(tree, '/orders/123', undefined, undefined, 'advance')
```

## Async Actions

Methods can be `async` to access the tree, read other nodes, or perform I/O:

```typescript
export class Portfolio {
  risk = 0.5

  async rebalance() {
    const { node, tree } = getCtx()
    const { items } = await tree.getChildren(join(node.$path, 'positions'))

    for (const pos of items) {
      // modify and save each position
      await tree.set(pos)
    }

    return { rebalanced: items.length }
  }
}
```

### getCtx() — accessing the execution context

Inside action methods, `getCtx()` provides the node, tree, and abort signal:

```typescript
import { getCtx } from '@treenx/core'

type ExecCtx = {
  node: NodeData       // the full node (Immer draft in sync actions)
  tree: Tree           // the tree instance
  signal: AbortSignal  // timeout signal (5 min default, configurable via ACTION_TIMEOUT env)
}
```

**Critical rule:** call `getCtx()` on the first line of the method, before any `await`:

```typescript
async rebalance() {
  const { node, tree } = getCtx()  // ← FIRST LINE, before any await
  // ... now use node and tree
}
```

After an `await`, the synchronous context is gone. Capture it early.

For sync methods that only mutate `this`, you don't need `getCtx()` at all.

## Generator Actions — Streaming

Async generator methods stream results back to the client:

```typescript
export class Builder {
  async *build(data: { count: number }) {
    const { node, tree, signal } = getCtx()

    for (let i = 0; i < data.count; i++) {
      if (signal.aborted) return

      const item = await buildItem(i)
      await tree.set(item)
      yield item  // → streamed to the client
    }
  }
}
```

Subscribe to the stream via tRPC:

```typescript
trpc.streamAction.subscribe(
  { path, action: 'build', data: { count: 10 } },
  { onData(item) { /* handle each yielded value */ } }
)
```

## Optimistic Concurrency

Every node has a `$rev` (revision) field. When an action modifies a node, the engine checks that `$rev` hasn't changed since the node was read. If another write happened in between, you get a conflict error.

This prevents lost updates in concurrent environments without locks.

## Helper Methods

If you need internal helper methods that shouldn't be called as actions, define them as plain functions outside the class or as static methods:

```typescript
function validateItems(items: string[]) { /* ... */ }

export class Order {
  addItem(data: { item: string }) {
    validateItems([...this.items, data.item])
    this.items.push(data.item)
  }
}
```

All prototype methods on a type class are registered as actions. There is no convention to hide individual methods — keep helper logic outside the class.

## When to Use Direct set()

`tree.set()` is valid in exactly these contexts:

- **Seed scripts** — creating initial data
- **Server-side actions** — inside an action method via `getCtx().tree`
- **Admin tools** — the built-in Inspector's form editor
- **Form editors** — generic CRUD UIs for node data

Never from client application code. If you're reaching for `tree.set()` in a React component, write an action instead.

## Related

- [Types](types.md) — defining type classes with registerType
- [Context](context.md) — how actions connect to the registry
- [Guide: Create a Mod](../guides/create-a-mod.md) — full walkthrough with actions
