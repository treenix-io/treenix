---
title: Hooks & APIs
section: api
order: 1
description: The five APIs you reach for every day — usePath, useChildren, useActions, execute, register
tags: [reference, hooks]
---

# Hooks & APIs

Five functions cover most Treenix apps. This page documents each in depth, then lists the rest by signature.

All examples assume typed [Types](../concepts/types.md) — `class TodoItem`, `class Bookmark` — registered with `registerType`.

## `usePath`

```typescript
import { usePath } from '@treenx/react/hooks'
```

Reactive read of a single path. Two modes.

### `usePath(uri, opts?)` — raw node

```typescript
usePath<T = NodeData>(uri: string | null, opts?: { once?: boolean }): Query<T | undefined>
```

Returns a `Query<NodeData | undefined>`. `uri` may include a `#key` fragment to read a named component.

```typescript
const { data: node, loading, error } = usePath('/config/app')

const { data: config } = usePath('/config/app#settings')   // named component
```

### `usePath(path, Class, key?)` — typed proxy

```typescript
usePath<T extends object>(path: string, cls: Class<T>, key?: string): Query<TypeProxy<T>>
```

Typed mode. `data` is a **TypeProxy** — field reads subscribe, method calls route through `execute()`. During initial load `loading` is `true` and field reads return `undefined`, but method calls always queue.

```typescript
const { data: task, loading } = usePath(ctx!.node.$path, Task)
if (loading) return <Spinner />

return (
  <div>
    <span>{task.title}</span>
    <button onClick={() => task.complete()}>Done</button>
  </div>
)
```

| Return field | Meaning |
|---|---|
| `data` | Node or TypeProxy (see overload) |
| `loading` | Initial fetch in flight |
| `error` | Last error; cleared on refetch success |
| `stale` | Has data; background revalidate in flight |
| `refetch()` | Force a refetch |

### Options

- `{ once: true }` — read without subscribing. No watcher, no re-render.

## `useChildren`

```typescript
import { useChildren } from '@treenx/react/hooks'

useChildren(parentPath: string | null, opts?: ChildrenOpts): ChildrenQuery
```

Paginated, reactive list of direct children.

```typescript
const { data: items, total, hasMore, loadMore, loadingMore } =
  useChildren('/tasks', {
    watch: true,       // re-render on changes to existing children
    watchNew: true,    // re-render when new children appear
    limit: 50,
  })

return (
  <>
    {items.map(item => <Render key={item.$path} value={item} />)}
    {hasMore && (
      <button onClick={loadMore} disabled={loadingMore}>
        {loadingMore ? 'Loading…' : `Load more (${items.length}/${total})`}
      </button>
    )}
  </>
)
```

| Return field | Meaning |
|---|---|
| `data` | `NodeData[]` — current page(s) concatenated |
| `total` | Server-reported total, or `null` before first response |
| `hasMore` | `data.length < total` |
| `loadingMore` | Next page append in flight |
| `truncated` | `true` when the server hit a result cap, `false` when it did not, `null` before first response |
| `loadMore()` | Fetch the next page; no-op if `!hasMore` |
| `loading` / `error` / `stale` / `refetch()` | Same as `usePath` |

### Options

- `limit: number` — page size. Default 100.
- `watch: boolean` — subscribe to existing children's changes.
- `watchNew: boolean` — subscribe to new children appearing.

## `useActions`

```typescript
import { useActions } from '@treenx/react/context'

useActions<T>(value: T): Actions<T>
```

Typed Proxy over a [Type](../concepts/types.md)'s methods. `value` is what a View receives in its props (`View<T>`); `useActions` returns an object whose fields are the Type's methods, typed, each routing to `execute()` on the server.

```typescript
const TodoCard: View<TodoItem> = ({ value }) => {
  const actions = useActions(value)
  return (
    <button onClick={actions.toggle}>
      {value.done ? '☑' : '☐'} {value.title}
    </button>
  )
}
```

**Requires** `value` to carry its `$node` symbol — set automatically by the rendering pipeline when a View is invoked through `<Render>`. Works without ceremony in any View; for hand-built cases, prefer `usePath(path, Class)` instead.

See [Type → RPC](../concepts/types.md#rpc) for the client-server story.

## `execute`

```typescript
import { execute } from '@treenx/react/hooks'

execute(path: string, action: string, data?: unknown, type?: string, key?: string): Promise<unknown>
```

Low-level action caller. Prefer `useActions(value)` inside Views. `execute` is for:

- **Cross-node calls** — acting on a node other than the one you're rendering.
- **Non-View contexts** — scripts, services, anywhere there's no `value` to wrap.

```typescript
// Acting on a different node
await execute('/orders/123', 'advance')
await execute('/orders/123', 'assign', { to: 'mia' })

// With a named component key
await execute('/project/42', 'addMember', { id: 'alice' }, 'acme.members', 'members')

// URI fragment syntax
await execute('/project/42#members', 'add', { id: 'alice' })
```

Optimistic: if the target node is in cache and a client-side handler is registered, the mutation applies locally first, then reconciles against the server commit. Rolls back on rejection.

## `register`

```typescript
import { register } from '@treenx/core'

register(Type: Class<T> | string, context: string, handler: Handler, meta?: Record<string, unknown>): void
```

Bind a handler to a Type in a Context. The central registration API — [Views](../concepts/context.md#views), [Services](../concepts/context.md#services), custom validators, custom mounts — everything hangs off this.

```typescript
import { register } from '@treenx/core'
import { Task } from './types'

// React view in default context
register(Task, 'react', TaskView)

// Compact list variant
register(Task, 'react:list', TaskRow)

// Edit form override
register(Task, 'react:edit', TaskEditor)

// Service — long-running handler
register(TelegramBot, 'service', async (value, ctx) => {
  /* ... */
  return { stop: async () => { /* cleanup */ } }
})
```

### Resolution

Resolves with cascade: exact → default at same context → strip suffix → recurse → null.

```
resolve(Task, 'react:kanban')
  1. Task    @ react:kanban  → found? use
  2. default @ react:kanban  → found? use
  3. Task    @ react          → found? use (suffix stripped)
  4. default @ react          → found? use
  5. null
```

### Pass the Class, not a string

```typescript
register(Task, 'react', TaskView)            // preferred — typed
register('todo.task', 'react', TaskView)     // legacy path, works but loses typing
```

Landing and current engine mods all use the Class form.

### Options

- `meta: Record<string, unknown>` — handler metadata. Recognized keys include `noOptimistic` (skip optimistic update on action handlers).

## Other hooks & APIs

Quick reference. Each has JSDoc in source if you need more; this list is where to look next.

| Symbol | Import | One-line |
|---|---|---|
| `set(node)` | `@treenx/react/hooks` | Persist a node with optimistic update + server commit |
| `watch(uri)` | `@treenx/react/hooks` | Async iterator over changes; for non-React code |
| `useNavigate()` | `@treenx/react/hooks` | Router-style navigation inside the admin UI |
| `useBeforeNavigate()` | `@treenx/react/hooks` | Warn on unsaved changes |
| `useCurrentNode()` | `@treenx/react/context` | Nearest `NodeProvider` value |
| `useTreeContext()` | `@treenx/react/context` | Current render context string (`react`, `react:list`, …) |
| `Render`, `RenderContext` | `@treenx/react/context` | The render pipeline — see [Contexts](../concepts/context.md) |
| `registerType(name, Class, opts?)` | `@treenx/core/comp` | Declare a Type — see [Type](../concepts/types.md) |
| `createNode(path, type, data?)` | `@treenx/core` | Build a NodeData — never by hand |
| `getComponent(node, Class|name)` | `@treenx/core` | Read a Component off a Node |
| `setComponent(node, Class, data)` | `@treenx/core/comp` | Write a Component onto a Node |
| `newComponent(Class, data?)` | `@treenx/core/comp` | Construct a Component standalone |
| `getCtx()` | `@treenx/core/comp` | Inside an action — access `tree`, `node`, caller |
| `isRef(value)` | `@treenx/core` | Type guard for `{ $type: 'ref', $ref }` |
| `dirname / basename / join / isChildPath` | `@treenx/core` | Path utilities |
| `R, W, A, S` | `@treenx/core` | ACL permission bits |
| `subscribePath / subscribeChildren` | `@treenx/react/tree/cache` | Low-level cache subscriptions — prefer hooks |

## Related

- [Type](../concepts/types.md) — where `registerType`, classes, and actions come from
- [Contexts](../concepts/context.md) — the resolution cascade in detail
- [Reactivity](../concepts/reactivity.md) — what the hooks subscribe to
- [Reference Overview](./overview.md)
- [Cookbook](../resources/cookbook.md) — hooks in working recipes
