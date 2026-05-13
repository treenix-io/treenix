---
title: React Views
section: guides
order: 2
description: Build typed views with hooks, context rendering, and composition patterns
tags: [guide, react, frontend]
---

# React Views

Views connect types to the UI. Register a React component for a type, and Treenix renders it whenever that type appears — in the tree browser, in lists, in other views.

## View Signature

Always use the typed `View<T>` signature. `value` is the **already reactive snapshot** delivered by `<Render>` — read fields directly. For actions, call `useActions(value)`.

```typescript
import { useActions, view, type View } from '@treenx/react'
import { Task } from './types'

const TaskView: View<Task> = ({ value, ctx }) => {
  const actions = useActions(value)
  // value: Task         — reactive typed component data
  // ctx.node: NodeData  — full node with $path, $type, $acl
  // ctx.path: string    — shortcut for ctx.node.$path
  // ctx.execute(action, data?) — low-level escape hatch (prefer useActions)

  return (
    <div>
      <span>{value.title}</span>
      <button onClick={() => actions.complete()}>Done</button>
    </div>
  )
}

view(Task, TaskView)
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

**Never use `{ value: any }` or `as any`** in view signatures.

## Hooks

### Reading fields — `value.X`

Inside `View<T>`, the `value` prop is the reactive proxy. Reading a field subscribes you automatically; **don't** wrap it in `usePath`:

```typescript
const TaskView: View<Task> = ({ value }) => {
  return <span>{value.title}</span>   // reactive — re-renders on SSE
}
```

**Anti-pattern — never inside `View<T>`:**

```typescript
// ❌ Duplicates the parent subscription, double-resolves the same node
const Bad: View<Task> = ({ value, ctx }) => {
  const { data: task } = usePath(ctx!.path, Task)
  return <span>{task.title}</span>
}
```

### `useActions(value)` — typed action proxy

```typescript
const actions = useActions(value)
await actions.complete()
await actions.setTags({ tags: ['done'] })
```

Every method call routes to `execute(path, methodName, data)` on the server. Typed end-to-end via `Actions<T>`. For non-streaming actions, returns `Promise<Awaited<ReturnType>>`. **Streaming (`async *`) actions** today consume through the typed `usePath(path, Class).data.foo()` proxy — see [Concepts: Actions](../concepts/actions.md).

### `useChildren` — reactive child list

```typescript
import { useChildren } from '@treenx/react'

const TaskList: View<Directory> = ({ value, ctx }) => {
  const { data: tasks, total, hasMore, loadMore, loadingMore } =
    useChildren(ctx!.path, {
      watch: true,      // subscribe to changes on existing children
      watchNew: true,   // subscribe to new children appearing
      limit: 50,
    })

  return (
    <div>
      {tasks.map(t => <Render key={t.$path} value={t} />)}
      {hasMore && (
        <button onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : `Load more (${tasks.length}/${total})`}
        </button>
      )}
    </div>
  )
}
```

`value: T` is component data — it has no `$path`. Always use `ctx!.path` for the current node's path.

### `usePath` — foreign paths only

For nodes **outside** the current view's value (refs, sibling reads, additional components by key):

```typescript
import { usePath } from '@treenx/react'

// Raw node read by URI
const { data: node, loading } = usePath('/config/app')

// Typed read of a foreign node
const { data: other } = usePath('/some/other/path', OtherType)

// Additional component on this node, by key (3rd arg)
const { data: chat } = usePath(ctx!.path, MetatronChat, 'chat')
```

`usePath` always returns `Query<T>` — destructure `.data` to read; the rest is `{ loading, error, stale, refetch }`. In typed mode (`usePath(path, Class)`) `data` is a **TypeProxy**: field reads subscribe to updates, method calls become `execute()` on the server.

## Registering Views

Use `view()` from `@treenx/react`. Pass the **Class** — it's typed end-to-end. The fallback chain resolves automatically: exact → default@same-ctx → strip suffix → recurse → null.

```typescript
view(Task, TaskDetailView)                  // 'react'         — default context
view.list(Task, TaskListItem)               // 'react:list'    — shortcut
view.compact(Task, TaskCompactView)         // 'react:compact' — shortcut
view.edit(Task, TaskEditForm)               // 'react:edit'    — shortcut
view(Task, 'kanban', TaskKanbanCard)        // 'react:kanban'  — any custom context
view.universal(Task, IsoView)               // 'react' + 'site' for SSR
```

### Render children through the registry

Never hardcode child components. Use `<Render>` and `<RenderContext>`:

```typescript
import { Render, RenderContext } from '@treenx/react'

// Render each child in list context
<RenderContext name="react:list">
  {tasks.map(t => <Render key={t.$path} value={t} />)}
</RenderContext>

// Render a single component in default context
<Render value={component} onChange={handleChange} />
```

This is how composition works: a kanban board renders order cards without knowing their view. Replace the `react:list` view for orders, and every list showing orders updates.

For list/card slot rendering, prefer `<RenderChildren items ctx />` from `@treenx/react/mods/editor-ui/list-items` — the **observer** owns chrome (border, padding, hover); the registered item view owns content only. See the `treenix-view-builder` skill.

### Current node and context

```typescript
import { useCurrentNode, useTreeContext } from '@treenx/react'

function SomeInnerComponent() {
  const node = useCurrentNode()      // NodeData from nearest NodeProvider
  const context = useTreeContext()   // 'react', 'react:list', etc.
}
```

## Calling Actions

Two typed ways, one low-level escape hatch:

```typescript
// 1. useActions(value) — typed Proxy from View props. Use this in views.
const actions = useActions(value)
await actions.complete()
await actions.setTags({ tags: ['done'] })

// 2. TypeProxy from usePath — data + typed methods on one object (foreign path / stream)
const { data: task } = usePath(path, Task)
await task.complete()
for await (const chunk of task.stream()) { /* … */ }

// 3. Global execute — only for cross-node calls from outside a view
import { execute } from '@treenx/react'
await execute('/other/node', 'someAction', { data: 1 })
```

Prefer **`useActions(value)`** inside views — shortest path, fully typed. Reach for `usePath(path, Class)` when you need typed actions on a foreign node, or to drive a streaming (`async *`) action.

## Navigation

```typescript
import { useNavigate } from '@treenx/react'

const navigate = useNavigate()
navigate('/tasks/new-task')  // navigate to node in the UI
```

The URL pattern is `/t/path/to/node` — e.g., `http://localhost:3210/t/tasks/deploy`.

## Styling

Treenix uses **Tailwind CSS v4** and theme tokens. Never inline `style={}` for colour/spacing.

```typescript
// RIGHT — token-based, theme-aware
<div className="flex gap-2 p-4 bg-card text-card-foreground rounded-md">

// WRONG — hardcoded palette / inline style
<div style={{ display: 'flex', gap: 8, padding: 16, background: '#151515' }}>
<div className="bg-zinc-900 text-zinc-100">
```

For conditional classes, use `cn()`:

```typescript
import { cn } from '@treenx/react'

<div className={cn(
  'px-3 py-2 rounded-md',
  active && 'bg-primary text-primary-foreground',
  disabled && 'opacity-50 cursor-not-allowed',
)}>
```

Reach for shadcn primitives first: `@treenx/react/ui/button`, `card`, `dialog`, `input`, etc. — all wired to theme tokens. Full token list in [docs/concepts/theming.md](../concepts/theming.md).

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `{ value: any }` | Use `View<T>` |
| `value.$path` inside `View<T>` | Use `ctx!.path` — `value: T` is component data, not node |
| `usePath(value.$path, T)` inside `View<T>` | Read `value.X` directly + `useActions(value)` |
| `<TaskRow task={t} />` | `<Render value={t} />` inside `<RenderContext>` |
| `register('type', 'react', view as any)` | `view(Class, view)` from `@treenx/react` |
| `ctx.execute('toggle')` | `useActions(value).toggle()` — typed |
| `useState(0)` + setTick for force re-render | Store meaningful state used in render |
| `useRef(new ExpensiveThing())` | `useState(() => new ExpensiveThing())` — lazy init |
| Inline `style={}` for colour / spacing | Tailwind tokens |

## Related

- [Concepts: Context](../concepts/context.md) — registry, fallback chain
- [Guide: Realtime](realtime.md) — subscriptions and live updates
- [Tutorial](../getting-started/tutorial.md) — first view from scratch
- Skill `treenix-view-builder` — full view pattern reference
