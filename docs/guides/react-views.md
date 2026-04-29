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

Always use the typed `View<T>` signature:

```typescript
import type { View } from '@treenx/react/context'
import { register } from '@treenx/core'
import { Task } from './types'

const TaskView: View<Task> = ({ value, ctx }) => {
  // value: Task        — typed component data
  // ctx.node: NodeData  — full node with $path, $type, $acl
  // ctx.path: string    — shortcut for ctx.node.$path
  // ctx.execute(action, data?) — low-level action caller (prefer useActions(value) in views)

  return <div>{value.title}</div>
}

register(Task, 'react', TaskView)
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

### usePath — reactive data + typed actions

```typescript
import { usePath } from '@treenx/react/hooks'
import { Task } from './types'

const TaskView: View<Task> = ({ value, ctx }) => {
  const { data: task } = usePath(ctx!.node.$path, Task)

  // task.title      — reactive field (re-renders on change)
  // task.done       — reactive field
  // task.complete() — calls execute('complete'), returns Promise
  // task.setTags({ tags: ['urgent'] }) — typed action call

  return (
    <div>
      <span>{task.title}</span>
      <button onClick={() => task.complete()}>Done</button>
    </div>
  )
}
```

`usePath` returns a `Query<T>` — `{ data, loading, error, stale, refetch }`. In typed mode (`usePath(path, Class)`) `data` is a **TypeProxy**: field reads subscribe to updates, method calls become `execute()` on the server. During initial load `data` is still a proxy — field reads yield `undefined` until the first fetch lands, but method calls always queue.

### useChildren — reactive child list

```typescript
import { useChildren } from '@treenx/react/hooks'

const TaskList: View<Directory> = ({ value, ctx }) => {
  const { data: tasks, total, hasMore, loadMore, loadingMore } =
    useChildren(ctx!.node.$path, {
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

### usePath — raw node read

Without a class, `usePath` returns `Query<NodeData | undefined>`:

```typescript
const { data: node, loading } = usePath('/config/app')
// node is NodeData | undefined
```

## Context Rendering

Register views for different contexts. The fallback chain resolves automatically:

```typescript
register(Task, 'react', TaskDetailView)       // default/detail
register(Task, 'react:list', TaskListItem)    // compact list
register(Task, 'react:edit', TaskEditForm)    // editor
```

### Render children through the registry

Never hardcode child components. Use `<Render>` and `<RenderContext>`:

```typescript
import { Render, RenderContext } from '@treenx/react/context'

// Render each child in list context
<RenderContext name="react:list">
  {tasks.map(t => <Render key={t.$path} value={t} />)}
</RenderContext>

// Render a single component in default context
<Render value={component} onChange={handleChange} />
```

This is how composition works: a kanban board renders order cards without knowing their view. Replace the `react:list` view for orders, and every list showing orders updates.

### Current node and context

```typescript
import { useCurrentNode, useTreeContext } from '@treenx/react/context'

function SomeInnerComponent() {
  const node = useCurrentNode()     // NodeData from nearest NodeProvider
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

// 2. TypeProxy from usePath — data + typed methods on one object
const { data: task } = usePath(path, Task)
await task.complete()
await task.setTags({ tags: ['done'] })

// 3. Global execute — only for cross-node calls from outside a view
import { execute } from '@treenx/react/hooks'
await execute('/other/node', 'someAction', { data: 1 })
```

Prefer **`useActions(value)`** inside views — it's the shortest path, fully typed, and matches the landing copy. Use `usePath(path, Class)` when you need both reactive data reads *and* typed actions on the same object.

## Navigation

```typescript
import { useNavigate } from '@treenx/react/hooks'

const navigate = useNavigate()
navigate('/tasks/new-task')  // navigate to node in the UI
```

The URL pattern is `/t/path/to/node` — e.g., `http://localhost:3210/t/tasks/deploy`.

## Styling

Treenix uses **Tailwind CSS v4**. Never use inline `style={}`.

```typescript
// RIGHT
<div className="flex gap-2 p-4 bg-muted rounded-lg">

// WRONG
<div style={{ display: 'flex', gap: 8, padding: 16 }}>
```

For conditional classes, use `tailwind-merge`:

```typescript
import { cn } from '@treenx/react/lib/utils'

<div className={cn(
  'px-3 py-2 rounded',
  active && 'bg-primary text-primary-foreground',
  disabled && 'opacity-50 cursor-not-allowed',
)}>
```

shadcn/ui components are available for common UI elements: `Button`, `Badge`, `Input`, `Card`, `Dialog`, etc.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `{ value: any }` | Use `View<T>` |
| `value.$path` | Use `ctx!.node.$path` — value is component data, not node |
| `<TaskRow task={t} />` | `<Render value={t} />` inside `<RenderContext>` |
| `register('type', 'react', view as any)` | `register(Class, 'react', view)` |
| `useState(0)` + setTick for force re-render | Store meaningful state used in render |
| `useRef(new ExpensiveThing())` | `useState(() => new ExpensiveThing())` — lazy init |
| Inline `style={}` | Tailwind classes |

## Related

- [Concepts: Context](../concepts/context.md) — registry, fallback chain
- [Guide: Realtime](realtime.md) — subscriptions and live updates
- [Tutorial](../getting-started/tutorial.md) — first view from scratch
