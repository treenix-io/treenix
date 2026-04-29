---
title: Type
section: concepts
order: 3
description: Write a class. Get storage, views, forms, RPC, schema, reactivity, and an MCP tool per method
tags: [core, beginner, types]
---

# Type

Write a class. Get [storage](#storage), [views](./context.md#views), [forms](#forms), [RPC](#rpc), [schema](#schema), [reactivity](./reactivity.md), and an [MCP](./ai-mcp.md) tool per method.

```typescript
import { registerType } from '@treenx/core/comp'

export class TodoItem {
  title = ''
  done = false

  /** @description Toggle done status */
  toggle() { this.done = !this.done }

  /** @description Update title */
  setTitle(data: { title: string }) {
    this.title = data.title
  }
}

registerType('todo.item', TodoItem)
```

`registerType` does three things:

1. **Stamps `$type`** on the class — `TodoItem.$type === 'todo.item'`.
2. **Records field defaults** accessible via `getDefaults(Class)`. JSON Schema for validation / UI auto-generates on dev server startup.
3. **Discovers methods** and registers each as `action:{name}` in the [Context](./context.md) registry.

Any [node](./composition.md#node) with `$type: 'todo.item'` now accepts `execute(path, 'toggle')` and `execute(path, 'setTitle', { title })` — and from React, `useActions(value).toggle()`.

## Storage {#storage}

Every Type instance persists into its [Node](./composition.md#node) automatically. Set a field in a React view and the change is [validated](./security.md#validation), [ACL-checked](./security.md#acl), committed, and broadcast to every subscriber.

Supported built-in backends: **Mongo · FS · Memory · any custom [Mount](./mounts.md)**.

The write pipeline — the same path every mutation walks, regardless of origin:

1. **Change.** A React view, cron, [workflow](./roadmap.md), or [service](./context.md#services) calls an action. The call enters the same pipeline whether it starts on the client or the server.
2. **Permissions.** [ACL](./security.md#acl) checks every access — read, write, execute — against the caller's role, inherited down the [tree](./tree.md). Every operation requires an explicit policy; the default is deny.
3. **Validate.** The [JSON Schema](#schema) generated from your Type validates every mutation or call. Wrong shape → rejected before it touches storage.
4. **Persist.** Committed to the configured backend via a [Mount](./mounts.md).
5. **Lineage.** The write is stamped with who, when, and via where — replayable, revertible, and traceable. See [Audit Trail](./audit.md).
6. **Broadcast.** The committed JSON Patch streams to every subscriber — other clients, running services, [agents](./ai-mcp.md). All views reconcile live through [Reactivity](./reactivity.md).

## Schema {#schema}

A Type's fields and methods generate a JSON Schema at boot. [Validation](./security.md#validation), [Forms](#forms), and [agent tool definitions](./ai-mcp.md) all compose from it.

```typescript
{
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'todo.item',
  type: 'object',
  properties: {
    title: { type: 'string' },
    done:  { type: 'boolean', default: false },
    priority: {
      type: 'string',
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },
  },
  required: ['title'],
  methods: {
    toggle: {
      description: 'Toggle done status',
    },
    setTitle: {
      description: 'Update title',
      arguments: [{
        name: 'data',
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      }],
    },
  },
}
```

Schemas are emitted to a `schemas/` directory next to the file that registers the Type, for example `mods/bookmarks/schemas/bookmarks.bookmark.json`. The generator reads your JSDoc annotations — see the [JSDoc table](#jsdoc-annotations) below.

## RPC {#rpc}

Actions are typed method calls. In React views, `useActions(value).toggle()` routes the call to the server. In server-side code, use `serverNodeHandle(tree)` for the same typed method surface.

```typescript
// React view (client)
const TodoCard: View<TodoItem> = ({ value }) => {
  const actions = useActions(value)
  return (
    <button onClick={actions.toggle}>
      {value.done ? '☑' : '☐'} {value.title}
    </button>
  )
}

// Server-side (cron, workflow, any handler)
import { serverNodeHandle } from '@treenx/core/server/actions'

const nightlyReset = async (tree) => {
  const node = serverNodeHandle(tree)
  await node('/todos/buy-milk').get(TodoItem).toggle()
}
```

No route files. No fetch wrapper. The action still runs through the same validation, ACL, persistence, and broadcast path.

## Optimistic Update {#optimistic-update}

You call an action from a React view — `useActions(value).toggle()`. The client applies it instantly. The server commits. Diffs reconcile via JSON Patch. If the server rejects, local state rolls back.

1. **Optimistic.** Client applies the action to local state — immediate update.
2. **Commit.** Server validates and emits a JSON Patch — server roundtrip.
3. **Rollback.** If the server rejects, local state reverts to the last committed value.

```typescript
const TodoCard: View<TodoItem> = ({ value }) => {
  const actions = useActions(value)
  return (
    <button onClick={actions.toggle}>
      {value.done ? '☑' : '☐'} {value.title}
    </button>
  )
}

register(TodoItem, 'react', TodoCard)
```

The shape of every realtime app, without the usual wiring. See [Reactivity](./reactivity.md) for the full multi-client picture.

## Forms {#forms}

A Type's fields compose into an edit form automatically — inputs for strings, checkboxes for booleans, selects for enums. Validation comes from the [Schema](#schema). You can bind a custom view for any input to customize the form.

```
┌──────────── Generated Form ────────────┐
│ title     [ Ship the landing        ]  │
│ done      [✓]                           │
│ priority  [ high ▾                  ]  │
└─────────────────────────────────────────┘
```

No UI code. The Inspector reads the Schema, picks widgets per JSDoc `@format` hints (see [JSDoc table](#jsdoc-annotations)), and renders per-field validation inline. Override any field by registering a view on the Field's Type.

## JSDoc annotations

Annotate fields and methods to power the [Inspector](#forms), MCP tool descriptions, and agent discovery:

```typescript
/** Kitchen order — tracks items through preparation */
export class CafeOrder {
  /** @title Items @description Ordered menu items */
  items: string[] = []

  /** @title Total @description Order total in cents */
  total = 0

  /** @title Status */
  status: 'new' | 'preparing' | 'done' = 'new'

  /** @description Start preparing the order */
  startPreparing() { this.status = 'preparing' }

  /** @description Add an item to the order */
  addItem(data: { item: string; price: number }) {
    this.items.push(data.item)
    this.total += data.price
  }
}

registerType('cafe.order', CafeOrder)
```

| Tag | Where | Purpose |
|---|---|---|
| First line | Class | Type title and description |
| `@title` | Field | Label in Inspector forms |
| `@description` | Field/Method | Tooltip / AI description |
| `@format` | Field | UI widget: `image`, `textarea`, `uri`, `email`, `path`, `tags`, `tstring`, `timestamp` |
| `@pre` | Method | Fields this action reads (dependency) |
| `@post` | Method | Fields this action writes (output) |

## Naming convention

```
dir                    core built-in (no dot)
t.mount.fs             treenix infrastructure (t.*)
todo.task              application type (namespace.name)
acme.block.hero        vendor type (namespace.category.name)
```

Rules:

- Always `.` as separator — not `/`, `@`, or `:`
- No dot = reserved for core Types
- `t.*` = reserved for Treenix infrastructure
- Your Types: `{your-namespace}.{name}`

## Type-safe access

Use the class for typed Component access:

```typescript
import { getComponent } from '@treenx/core'
import { setComponent, newComponent } from '@treenx/core/comp'
import { TodoItem } from './types'

// Typed read — returns the main component if node.$type matches
const todo = getComponent(node, TodoItem)        // typed as TodoItem | undefined

// Typed write
setComponent(node, TodoItem, { title: 'New', done: false })

// Create standalone
const fresh = newComponent(TodoItem, { title: 'Draft', done: false })
// { $type: 'todo.item', title: 'Draft', done: false }
```

See [Composition → Component](./composition.md#component) for the getComponent resolution rule.

## Options

`registerType` accepts an options object:

```typescript
registerType('report.summary', ReportSummary, {
  needs: ['data'],
  ports: {
    generate: { pre: ['rawData'], post: ['summary'] }
  },
})
```

### `needs` — sibling dependencies

Declare what other Components an action needs. Components never access siblings directly — dependencies are explicit.

Patterns:

- `status` — bare name, resolves sibling on the same node
- `@configPath` — field reference, reads a field value as a path
- `/sys/config` — absolute path to another node
- `./sibling` or `../parent` — relative path
- `/orders/*` — children pattern, resolves all children at path

### `ports` — action I/O

Declare what an action reads and writes. Metadata for dependency graph analysis and visual pipeline editors — no runtime effect.

## Introspection

Query registered Types:

```typescript
import { getRegisteredTypes, getContextsForType } from '@treenx/core'

getRegisteredTypes('schema')        // ['todo.item', 'cafe.order', ...]
getContextsForType('todo.item')     // ['schema', 'react', 'action:toggle', ...]
```

Or via MCP:

```
catalog                              → all Types with summaries
describe_type  { type: 'cafe.order' } → full schema + actions + cross-refs
search_types   { query: 'order' }     → keyword search
```

## Related

- [Composition](./composition.md) — how Types attach as Components
- [Contexts](./context.md) — how Types render per surface
- [Actions](./actions.md) — Immer drafts, generators, `getCtx()`
- [Security → Validation](./security.md#validation) — Schema-driven runtime checks
- [Reactivity](./reactivity.md) — the realtime patch stream
- [AI / MCP](./ai-mcp.md) — Type methods as agent tools
- Guide: [Document Your Types](../guides/documenting-types.md)
- Guide: [Build a Mod](../guides/create-a-mod.md)
