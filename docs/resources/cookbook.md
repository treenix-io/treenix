---
title: Cookbook
section: resources
order: 1
description: Copy-paste recipes for the most common Treenix patterns
tags: [recipes, examples]
---

# Cookbook

Seven short recipes. Each is a complete, runnable snippet — drop it into a mod, adjust names, it works.

## 1. Subscribe to a path with optimistic UI

A View that renders a typed node and mutates it with `useActions`. Optimistic updates come for free — the click reflects instantly.

```typescript
import { useActions, view, type View } from '@treenx/react'
import { Counter } from './types'

const CounterView: View<Counter> = ({ value }) => {
  const actions = useActions(value)
  return (
    <div className="flex items-center gap-3">
      <span className="text-3xl tabular-nums">{value.count ?? 0}</span>
      <button onClick={() => actions.increment()} className="px-3 py-1 rounded bg-primary text-primary-foreground">+</button>
      <button onClick={() => actions.decrement()} className="px-3 py-1 rounded border">−</button>
    </div>
  )
}

view(Counter, CounterView)
```

`value.count` subscribes; `actions.increment()` applies locally, commits on the server, broadcasts to other clients. See [Type → Optimistic Update](../concepts/types.md#optimistic-update).

## 2. Paginate large children lists

Render many children without loading them all. Request a page, show "load more" when there is more.

```typescript
import type { View } from '@treenx/react'
import { useChildren } from '@treenx/react'
import { Render } from '@treenx/react'

const Inbox: View<any> = ({ ctx }) => {
  const { data: items, total, hasMore, loadMore, loadingMore } =
    useChildren(ctx!.path, { limit: 50, watch: true, watchNew: true })

  return (
    <div className="space-y-1">
      {items.map(it => <Render key={it.$path} value={it} />)}
      {hasMore && (
        <button onClick={loadMore} disabled={loadingMore}
                className="w-full py-2 text-sm text-muted-foreground">
          {loadingMore ? 'Loading…' : `Load more (${items.length} / ${total})`}
        </button>
      )}
    </div>
  )
}
```

`{ watch: true, watchNew: true }` keeps both existing and new children reactive. See [Go Realtime](../guides/go-realtime.md).

## 3. Seed a mod from declarative data

A prefab registers nodes that deploy idempotently at startup.

```typescript
import type { NodeData } from '@treenx/core'
import { registerPrefab } from '@treenx/core/mod'

registerPrefab('todo', 'seed', [
  { $path: '/todo', $type: 'dir' },
  { $path: '/todo/list', $type: 'todo.list', title: 'Inbox' },
  { $path: '/todo/list/1', $type: 'todo.item', title: 'Read the Tutorial', done: false },
  { $path: '/todo/list/2', $type: 'todo.item', title: 'Build a mod', done: false },
] as NodeData[])
```

Existing nodes are skipped; new ones are created. Local mods load `seed.ts` by convention on server startup. See [Build a Mod](../guides/create-a-mod.md).

## 4. Lock a field to a role (ACL)

Make a subtree writable only by admins, readable by everyone.

```typescript
import { makeNode, R, W, A, S } from '@treenx/core'

await tree.set(makeNode('/finance/ledger', 'dir', {
  $acl: [
    { g: 'admins', p: R | W | A | S },
    { g: 'finance', p: R | S },
    { g: 'public', p: 0 },              // sticky deny — child nodes cannot re-grant
  ],
}))
```

`p: 0` is a **sticky deny** — descendant nodes cannot re-grant public access. `R | W | A | S` = full control. See [Security → ACL](../concepts/security.md#acl).

## 5. Mount a remote Treenix as a subtree

Bring another instance's subtree into yours. Remote nodes look local; the other side's ACL applies at the boundary.

```typescript
import { makeNode } from '@treenx/core'

await tree.set(makeNode('/partner', 'mount-point', {}, {
  mount: {
    $type: 't.mount.tree.trpc',
    url: 'https://globex.io/trpc',
  },
}))

// Now /partner/projects/alpha is just another path
const project = await tree.get('/partner/projects/alpha')
```

See [Composition → Forest](../concepts/composition.md#forest) and [Mounts](../concepts/mounts.md).

## 6. Add a custom context for a Type

Register the same Type for a different surface — e.g., a compact row for list views.

```typescript
import { useActions, view, type View } from '@treenx/react'
import { TodoItem } from './types'

const TodoRow: View<TodoItem> = ({ value }) => {
  const actions = useActions(value)
  return (
    <label className="flex items-center gap-2 py-1">
      <input
        type="checkbox"
        checked={value.done ?? false}
        onChange={actions.toggle}
      />
      <span className={value.done ? 'line-through text-muted-foreground' : ''}>
        {value.title}
      </span>
    </label>
  )
}

view.list(TodoItem, TodoRow)
```

Anywhere `<Render value={todo} />` runs inside `<RenderContext name="react:list">`, it gets `TodoRow`. If absent, the cascade falls back to the `react` view automatically. See [Contexts](../concepts/context.md).

## 7. Action that creates a child node

Mutate the tree from inside an action by using the `tree` handle from `getCtx()`.

```typescript
import { getCtx, registerType } from '@treenx/core'

export class TodoList {
  title = 'Inbox'

  /** @description Add a todo item */
  async add(data: { title: string }) {
    if (!data.title?.trim()) throw new Error('Title required')
    const { node, tree } = getCtx()
    const id = Date.now().toString(36)
    await tree.set({
      $path: `${node.$path}/${id}`,
      $type: 'todo.item',
      title: data.title.trim(),
      done: false,
    })
  }
}

registerType('todo.list', TodoList)
```

Inside an action, `getCtx()` gives you the running `tree`, the current `node`, and the caller identity. Writes through the passed `tree` share the same [write pipeline](../concepts/types.md#storage) as any other mutation — [ACL](../concepts/security.md#acl) + [Validation](../concepts/security.md#validation) + [Audit](../concepts/audit.md).

## Related

- [Tutorial](../getting-started/tutorial.md) — a longer walkthrough
- [Build a Mod](../guides/create-a-mod.md) — patterns in context
- [Troubleshooting](../guides/troubleshooting.md) — when a recipe above misbehaves
- [Hooks & APIs](../api/hooks.md) — full reference for the functions used here
