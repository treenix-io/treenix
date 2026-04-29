---
title: Nodes
section: concepts
order: 1
description: The universal building block — a typed, addressable entity in the tree
tags: [core, beginner]
---

# Nodes

A node is a typed piece of data with an address. Every entity in Treenix — a task, a user, a config file, a sensor reading — is a node.

```typescript
{
  $path: '/tasks/buy-milk',
  $type: 'todo.task',
  title: 'Buy milk',
  done: false
}
```

That's it. A path, a type, and data.

## Paths

Every node has a unique `$path` — its address in the tree. Paths work like a filesystem:

```
/                       root
/tasks                  a directory
/tasks/buy-milk         a task node
/tasks/buy-milk/notes   a child of the task
```

Children are discovered by path prefix query, not stored inside the parent. To get all tasks: `tree.getChildren('/tasks')`. No array to maintain, no ordering bugs, no N+1.

Path utilities:

```typescript
import { dirname, basename, join, isChildPath } from '@treenx/core'

dirname('/tasks/buy-milk')                // '/tasks'
basename('/tasks/buy-milk')               // 'buy-milk'
join('/tasks', 'buy-milk')                // '/tasks/buy-milk'
isChildPath('/tasks', '/tasks/buy-milk')  // true (direct child)
```

## Types

Every node has a `$type` that determines its behavior. Types follow a naming convention:

| Pattern | Examples | Meaning |
|---------|----------|---------|
| No dot | `dir`, `ref`, `root`, `user` | Core built-in types |
| `t.*` | `t.mount.fs`, `t.mount.mongo` | Treenix infrastructure |
| `{namespace}.*` | `todo.task`, `cafe.order` | Application types |

The separator is always `.` — not `/`, not `@`, not `:`.

## System Fields

Fields prefixed with `$` are reserved by the engine:

| Field | Purpose |
|-------|---------|
| `$path` | Absolute path in the tree |
| `$type` | Type identifier |
| `$rev` | Revision number for optimistic concurrency control |
| `$owner` | User ID of the node owner |
| `$acl` | Access control list |
| `$refs` | Internal reference tracking |

Everything else is your data.

## Creating Nodes

Use `createNode()` — never construct node objects by hand:

```typescript
import { createNode } from '@treenx/core'

// With a string type
const task = createNode('/tasks/buy-milk', 'todo.task', {
  title: 'Buy milk',
  done: false,
})

// With a class — get autocomplete and type checking
import { Task } from './types'
const task = createNode('/tasks/buy-milk', Task, {
  title: 'Buy milk',  // ← IDE knows this field exists
  done: false,
})
```

To persist a node, write it to the tree:

```typescript
await tree.set(task)
```

## Reading Nodes

```typescript
// Get a single node
const task = await tree.get('/tasks/buy-milk')

// Get children of a path
const { items, total } = await tree.getChildren('/tasks', {
  limit: 50,
  offset: 0,
})
```

In React, use hooks for reactive reads:

```typescript
import { usePath, useChildren } from '@treenx/react/hooks'

// Reactive single node (re-renders on change)
const { data: task } = usePath('/tasks/buy-milk')

// Reactive children list
const { data: tasks } = useChildren('/tasks', { watch: true, watchNew: true })
```

## Components

A node can carry multiple **components** — named fields with their own `$type`. This is how you attach extra data without changing the node's type:

```typescript
const task = createNode('/tasks/buy-milk', 'todo.task', {
  title: 'Buy milk',
  done: false,
}, {
  // additional components (different $type than the node)
  priority: { $type: 'task.priority', level: 'high' },
  thread:   { $type: 'forum.thread', messages: [] },
})
```

The node's own type (`todo.task`) is the **main component** — its fields live at the node level. Named keys like `priority` and `thread` are additional components. Each has its own `$type` and renders independently through the context system.

Read more: [Components](components.md)

## The Node is its Main Component

This is a crucial pattern: when you call `getComponent(node, Task)` and the node's `$type` matches `Task`, it returns the **node itself**. The main component's fields are at the node level.

```typescript
// RIGHT — fields at node level
{ $path: '/tasks/1', $type: 'todo.task', title: 'Buy milk', done: false }

// WRONG — main component duplicated in a named key
{ $path: '/tasks/1', $type: 'todo.task', task: { $type: 'todo.task', title: 'Buy milk' } }
```

Named keys are for *additional* components with a *different* `$type` than the node.

## Refs

A node can be a reference — a pointer to another node:

```typescript
import { ref, isRef } from '@treenx/core'
import { resolveRef } from '@treenx/core/tree'

const pointer = ref('/tasks/buy-milk')
// { $type: 'ref', $ref: '/tasks/buy-milk' }

isRef(pointer)  // true

const target = await resolveRef(tree, pointerNode)  // → the actual task node
```

Refs point to nodes only — never to deep paths or fields inside a node.

## Removing Nodes

```typescript
await tree.remove('/tasks/buy-milk')  // returns true if existed
```

Removing a node does not automatically remove its children. Children are separate nodes at deeper paths.

## Related

- [Components](components.md) — multiple typed data aspects on a single node
- [Types](types.md) — registerType, schema generation, type classes
- [Tree](tree.md) — the data interface, adapters, and combinators
