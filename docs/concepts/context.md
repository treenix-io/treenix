---
title: Contexts
section: concepts
order: 5
description: The registry that binds Types to behavior — views, services, actions, validators
tags: [core, beginner, contexts]
---

# Contexts

[Views](#views) and [Services](#services) (and other Type traits) register against [Type](./types.md) + Context. The same node could render as a card, table row, or map pin — or boot a long-running handler — depending on the context you specify at render time.

```typescript
import { register } from '@treenx/core'
import { TodoItem, TelegramBot } from './types'

register(TodoItem, 'react',       TodoCard)
register(TodoItem, 'react:table', TodoRow)
register(TodoItem, 'react:flow',  TodoFlowCard)
register(TodoItem, 'react:map',   TodoMapPin)

register(TelegramBot, 'service',  BotHandler)
```

Resolution cascade: **exact context → default at the same level → strip suffix → recurse → null.**

```
resolve(TodoItem, 'react:kanban')
  1. TodoItem @ react:kanban     → found? use it
  2. default  @ react:kanban     → found? use it
  3. TodoItem @ react            → found? use it (strip suffix)
  4. default  @ react            → found? use it
  5. null                         → no handler
```

Registering in `react` automatically covers any `react:*` sub-context unless a more specific handler exists.

## Context Types

| Context | Handler signature | Purpose |
|---|---|---|
| `react` | `View<T>` (React FC) | Detail view |
| `react:list` | `View<T>` | Compact list item |
| `react:edit` | `View<T>` | Edit form |
| `text` | `(data) => string` | Plain text (AI, CLI, notifications) |
| `schema` | `() => JSONSchema` | Inspector forms, validation |
| `action:*` | auto-generated | Server actions (from Type methods) |
| `service` | `(node, ctx) => ServiceHandle` | Background worker |
| `mount` | `(mount, ctx) => Tree \| Promise<Tree>` | Storage adapter |
| `acl` | `() => GroupPerm[]` | Default permissions for the Type |
| `telegram` | `(node, tgCtx) => void` | Telegram bot handler |

You can define custom contexts too — the system doesn't hardcode these. Register under any string; resolve with the same chain.

## Sealed Registry

The registry is **sealed**: duplicate `register()` calls for the same `(Type, context)` pair are silently ignored. HMR-safe — hot-reloading won't double-register.

You can't override a handler. To customize behavior, register a more specific context:

```typescript
// Can't override the base registration:
register(TodoItem, 'react', OriginalView)

// Instead, register a new context:
register(TodoItem, 'react:mobile', MobileView)
```

## Views {#views}

Views are chosen at render time by context — a string like `react:card` or `telegram:view`. Register a renderer per context and drop the node anywhere with `<Render value={value} ctx="react:card" />`.

```typescript
import { Render, RenderContext } from '@treenx/react/context'

// Render a component in the current context
<Render value={component} onChange={handler} />

// Set context for a subtree of renders
<RenderContext name="react:list">
  {items.map(item => <Render key={item.$path} value={item} />)}
</RenderContext>
```

Never hardcode component imports in a View. Use `<Render>` so the registry picks the right renderer.

### Typed View signature

```typescript
import type { View } from '@treenx/react/context'
import { useActions } from '@treenx/react/context'
import { TodoItem } from './types'

const TodoCard: View<TodoItem> = ({ value, ctx }) => {
  const actions = useActions(value)
  return (
    <button onClick={actions.toggle}>
      {value.done ? '☑' : '☐'} {value.title}
    </button>
  )
}

register(TodoItem, 'react', TodoCard)
```

`View<T>` is `FC<RenderProps<T>>` where:

```typescript
type RenderProps<T> = {
  value: T
  onChange?: (next: T) => void
  ctx?: ViewCtx | null
}

type ViewCtx = {
  node: NodeData
  path: string
  execute(action: string, data?: unknown): Promise<unknown>
}
```

Always pass the Class — `register(TodoItem, 'react', TodoCard)`, not `register('todo.item', ...)`. The Class is the identity; string-based registration is a legacy path that lacks autocomplete.

For the full set of hook and view patterns see [Write React Views](../guides/react-views.md).

## Services {#services}

A long-running handler pinned to a [Node](./composition.md#node). Same registration shape as a [View](#views) — context is `service`. Lifecycle follows the node; config is the Node's typed fields.

```typescript
import { register } from '@treenx/core'
import { TelegramBot } from './types'

// When a node is rendered as a service, the handler starts with the node as config.
register(TelegramBot, 'service', async (value, ctx) => {
  const bot = new Bot(value.token)
  bot.on('message', handleMessage)
  await bot.start()

  return {
    stop: async () => bot.stop(),
  }
})
```

**Pinned to a node.** Starts, holds state, and cleans up through `stop()` on shutdown. The Service runs under the same [tree](./tree.md), [ACL](./security.md#acl), and [audit trail](./audit.md) as user actions — no back door.

Typical uses: telegram bots, ingestion loops, cron tickers, MQTT consumers, any background process whose configuration should live in the same tree as the app.

See [Run Services](../guides/services.md) for a full service mod walkthrough.

## Defining custom contexts

Nothing prevents you from inventing a new context. Register against it, and call `<Render ctx="your-context" />` or `resolve(Type, 'your-context')` where you need the handler.

Example — a `pdf` context for server-side PDF exports:

```typescript
register(Invoice, 'pdf', (value) => renderInvoicePdf(value))

// somewhere on the server
const pdf = resolve(Invoice, 'pdf')?.(invoiceNode) ?? emptyBuffer
```

The fallback cascade still applies — if `Invoice @ pdf` isn't registered, `default @ pdf` can provide a generic PDF handler.

## Related

- [Composition → Component](./composition.md#component) — what `value` carries into a View
- [Type](./types.md) — the other half of every `register(Type, context, handler)` call
- [Reactivity](./reactivity.md) — how View re-renders happen
- [Security](./security.md) — ACL on every resolve, validation on every Type mutation
- Guide: [Write React Views](../guides/react-views.md)
- Guide: [Run Services](../guides/services.md)
