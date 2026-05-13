---
title: Services
section: guides
order: 7
description: Background workers — bots, sensors, watchers, periodic tasks
tags: [guide, intermediate]
---

# Services

A service is a long-running background process tied to a node. While actions are request-response, services run continuously — polling APIs, watching for changes, generating data.

## Defining a Service

Register a handler for the `service` context:

```typescript
import { makeNode } from '@treenx/core'
import { register } from '@treenx/core'
import type { ServiceHandle } from '@treenx/core/contexts/service'

register('my-worker', 'service', async (node, ctx) => {
  // node — the node this service is attached to
  // ctx.tree — the tree instance
  // ctx.subscribe — subscribe to tree changes

  const timer = setInterval(async () => {
    await ctx.tree.set(makeNode(
      `${node.$path}/${Date.now()}`,
      'tick',
      { ts: Date.now() },
    ))
  }, 5000)

  return {
    stop: async () => clearInterval(timer),
  } satisfies ServiceHandle
})
```

The handler receives the service node and a context. It returns an object with a `stop()` method for cleanup.

## Autostart

Services don't run automatically. To start a service when the server boots, add a ref to `/sys/autostart`:

```typescript
// 1. Create the service node
await tree.set(makeNode('/my-worker', 'my-worker'))

// 2. Create an autostart ref
await tree.set(makeNode('/sys/autostart/my-worker', 'ref', {
  $ref: '/my-worker',
}))
```

At startup, `startServices()` walks `/sys/autostart`, resolves each ref, and calls the matching service handler.

In seed data:

```typescript
registerPrefab('my-mod', 'seed', [
  makeNode('/my-worker', 'my-worker', { /* config */ }),
  makeNode('/sys/autostart/my-worker', 'ref', { $ref: '/my-worker' }),
])
```

## Watching the Tree

Services commonly watch for changes and react:

```typescript
import { executeAction } from '@treenx/core/server/actions'

register('cook-bot', 'service', async (node, ctx) => {
  const unsub = ctx.subscribe('/orders/incoming', async (event) => {
    if (event.type === 'set') {
      // New order appeared — start preparing
      await executeAction(ctx.tree, event.path, 'order.status', undefined, 'startPreparing')
    }
  })

  return { stop: async () => unsub() }
})
```

This pattern — watch a query mount, react to changes — is how you build event-driven pipelines without a separate message queue.

## Reading Config from the Node

Service configuration typically lives on the service node itself as a component:

```typescript
import { getComponent } from '@treenx/core'
import { SensorConfig } from './types'

register('sensor', 'service', async (node, ctx) => {
  const config = getComponent(node, SensorConfig)
  const interval = (config?.interval ?? 5) * 1000

  const timer = setInterval(async () => {
    // ... generate reading
  }, interval)

  return { stop: async () => clearInterval(timer) }
})
```

## Lifecycle

- **Start:** server boot → `startServices()` → resolves autostart refs → calls handlers
- **Running:** handler keeps running until `stop()` is called
- **Stop:** server shutdown calls `stop()` on all active services

Services are restarted on server restart. There is no hot-reload for services — restart the server after changes.

## Related

- [Guide: Create a Mod](create-a-mod.md) — services in the mod lifecycle
- [Guide: Realtime](realtime.md) — subscriptions that services use
- [Concepts: Context](../concepts/context.md) — the `service` context
