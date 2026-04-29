---
title: Components
section: concepts
order: 2
description: Typed data aspects attached to nodes — ECS composition for the tree
tags: [core, beginner]
---

# Components

A component is a piece of typed data attached to a node. Think of it as an aspect — a task node can carry a priority component, a comment thread, and a notification config. Each is independent, each renders through its own view.

```typescript
{
  $path: '/tasks/deploy',
  $type: 'todo.task',
  title: 'Deploy v2',          // ← main component fields (todo.task)
  done: false,
  priority: {                   // ← additional component
    $type: 'task.priority',
    level: 'critical',
  },
  thread: {                     // ← another additional component
    $type: 'forum.thread',
    messages: [],
  },
}
```

Three components on one node. No coupling between them. Each has its own type, schema, actions, and views.

## Main Component vs Named Components

The node's `$type` defines its **main component**. Its fields live directly at the node level — not inside a named key.

```typescript
// The node IS its main component
getComponent(node, Task)  // → returns the node itself (title, done, etc.)

// Named keys are additional components
getComponent(node, 'task.priority')  // → { $type: 'task.priority', level: 'critical' }
```

This is a deliberate design: `getComponent(node, Class)` checks `node.$type` first. If it matches, the node *is* the component.

**Common mistake:**

```typescript
// WRONG — duplicating the main component in a named key
{
  $type: 'todo.task',
  task: { $type: 'todo.task', title: 'Deploy' }  // ← this is ignored
}

// RIGHT — main component fields at node level
{
  $type: 'todo.task',
  title: 'Deploy',
  done: false,
}
```

## Working with Components

```typescript
import { getComponent, removeComponent } from '@treenx/core'
import { setComponent, newComponent } from '@treenx/core/comp'

// Read a component by type (string or class)
const priority = getComponent(node, 'task.priority')
// → { $type: 'task.priority', level: 'critical' } | undefined

// Remove a named component by key
removeComponent(node, 'priority')
```

### Type-safe access with classes

`setComponent` and `newComponent` take a class for type safety:

```typescript
import { Bookmark } from './types'

const bm = getComponent(node, Bookmark)
// bm is typed as ComponentData<Bookmark> | undefined
// bm.url, bm.title, bm.tags — all typed

setComponent(node, Bookmark, { tags: ['updated'] })
```

## ECS Composition

Treenix follows the **Entity-Component-System** pattern. Nodes are entities, components are data, contexts are systems.

This means:

**Search existing types first.** Before creating a new type, check what's already registered. Use `catalog` (MCP) or `getRegisteredTypes()`.

**One universal type per domain.** A task is a task — human or AI, doesn't matter at the type level. Distinguish via field values, not new types.

**Custom data = additional components.** Don't add domain-specific fields to a generic type. Attach a component with a different `$type`:

```typescript
// Instead of bloating todo.task with AI fields:
{
  $type: 'todo.task',
  title: 'Review PR',
  done: false,
  ai: {                              // additional component
    $type: 'metatron.context',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: '...',
  },
}
```

**Components don't access siblings.** A priority component doesn't know about the thread component on the same node. If a component needs data from a neighbor, declare it via `needs`:

```typescript
registerType('report.summary', ReportSummary, {
  needs: ['data']
})
```

## Component Identity

A component is identified by its key (the field name on the node) and its `$type`:

```typescript
{
  $path: '/sensors/temp',
  $type: 'sensor',
  config: { $type: 'sensor.config', interval: 10 },  // key: 'config'
  alert:  { $type: 'alert.rule', threshold: 90 },     // key: 'alert'
}
```

To check if a value is a component:

```typescript
import { isComponent, isOfType } from '@treenx/core'

isComponent(value)                    // has $type field
isOfType(value, 'sensor.config')      // has $type === 'sensor.config'
```

## Related

- [Nodes](nodes.md) — the entity that carries components
- [Types](types.md) — defining type classes with registerType
- [Actions](actions.md) — mutating component data through methods
- [Context](context.md) — how components render in different surfaces
