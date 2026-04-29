---
title: Thinking in Treenix
section: getting-started
order: 4
description: One node, many components, many views — the mental model, through a worked example
tags: [intro, mental-model, beginner]
---

# Thinking in Treenix

You've finished the [Tutorial](./tutorial.md). You can define a [Type](../concepts/types.md), wire a [View](../concepts/context.md#views), and read a [node](../concepts/nodes.md). This page is about the part that isn't syntax — how to **model** in Treenix.

We'll take a small design problem and solve it twice: once the way most stacks expect, and once the way Treenix wants. The second version is not cleverer or shorter. It's smaller because things that look like separate features are the same thing here.

## The problem

A team wants a task tracker. Each task should also support a discussion — comments, replies, reactions. You've seen this exact combination many times: Linear, GitHub Issues, Asana, Notion.

## The stack's answer

You'd build at least four things:

- a `Task` table — title, status, assignee, due date
- a `Thread` table — the forum for discussions
- a `thread_attachments` join — "this thread belongs to this task"
- two APIs — `tasks.create`, `threads.post` — and two UIs that render each

The pieces are clear; so are the seams. Changing a task's ownership rules means touching the `Task` side. Adding a file attachment to a comment is entirely in `Thread` land. When you want the task's activity feed to include mentions from the thread, you write a join query and remember to invalidate two caches.

It works. It's also, in a way, the shape of the problem rather than the shape of the domain. A "task with discussion" is *one concept*. The code splits it because the data store and the API forced you to.

## The Treenix answer

One [node](../concepts/nodes.md). Two [components](../concepts/composition.md#component).

```typescript
// The node IS its main component — so its fields sit at node level.
// Extra components attach under a key with their own $type.
{
  $path: '/work/q2-launch',
  $type:  'acme.task',
  title:  'Ship the Q2 launch',
  status: 'active',
  assignee: 'mia',

  thread: {                          // extra component, keyed
    $type: 'acme.thread',
    messages: [
      { author: 'leo', text: 'Draft is in figma' },
      { author: 'mia', text: 'Review tonight' },
    ],
  },
}
```

That's the whole data model. Two [Types](../concepts/types.md), one node, a single `$path` the rest of the system can route on.

You define the two Types as classes, the same way you would anywhere else:

```typescript
import { registerType } from '@treenx/core/comp'

export class AcmeTask {
  title = ''
  status: 'active' | 'done' = 'active'
  assignee = ''

  /** @description Mark the task done */
  complete() { this.status = 'done' }

  /** @description Reassign to someone else */
  reassign(data: { to: string }) { this.assignee = data.to }
}
registerType('acme.task', AcmeTask)

export class AcmeThread {
  messages: { author: string; text: string }[] = []

  /** @description Post a message */
  post(data: { author: string; text: string }) {
    this.messages.push(data)
  }
}
registerType('acme.thread', AcmeThread)
```

Nothing ties them together at this level. No join table, no foreign key. They share a node; that's the link.

## Render it twice

Now the interesting part. [Contexts](../concepts/context.md) let the same typed data appear in different surfaces — each decided at render time, no duplication:

```typescript
import { register } from '@treenx/core'
import { useActions } from '@treenx/react/context'
import { AcmeTask, AcmeThread } from './types'

// The task, as a board card.
const TaskCard: View<AcmeTask> = ({ value }) => {
  const actions = useActions(value)
  return (
    <article>
      <h3>{value.title}</h3>
      <span>{value.status} — {value.assignee || 'unassigned'}</span>
      <button onClick={() => actions.complete()}>Complete</button>
    </article>
  )
}
register(AcmeTask, 'react', TaskCard)

// The thread, as a forum panel.
const ThreadPanel: View<AcmeThread> = ({ value }) => {
  const actions = useActions(value)
  return (
    <div>
      {value.messages.map((m, i) => (
        <p key={i}><b>{m.author}</b>: {m.text}</p>
      ))}
      <button onClick={() => actions.post({ author: 'me', text: 'hi' })}>Reply</button>
    </div>
  )
}
register(AcmeThread, 'react', ThreadPanel)
```

Drop the node into a board view and `TaskCard` renders. Drop the `thread` [component](../concepts/composition.md#component) into a discussion panel and `ThreadPanel` renders. Both read from the same node, [broadcast](../concepts/reactivity.md) through the same live stream, live under the same [ACL](../concepts/security.md#acl).

## The momentum test

A week later the product team asks for a calendar. Tasks with a due date should appear as entries in a monthly grid.

If the app were built the first way — two tables, two APIs — you'd add a `due_date` column, a calendar endpoint, a new UI, and likely a new join somewhere. Real work.

In Treenix the change is smaller than the sentence describing it:

```typescript
// 1. Add the field to the Type.
export class AcmeTask {
  title = ''
  status: 'active' | 'done' = 'active'
  assignee = ''
  dueDate?: string          // ← new

  /* ...methods unchanged... */
}

// 2. Register a calendar view in a new context.
const TaskCalendarEntry: View<AcmeTask> = ({ value }) => (
  <div title={value.title}>
    {value.dueDate?.slice(5)} — {value.title}
  </div>
)
register(AcmeTask, 'react:calendar', TaskCalendarEntry)
```

The board keeps working. The thread keeps working. Agents keep seeing the task [as an MCP tool](../concepts/ai-mcp.md). The calendar is *also* the task — not a view of a projection of a row, just the same node rendered through a different [context](../concepts/context.md).

## What happened

You modelled the domain as one thing. The platform gave you:

- **Shared identity.** `/work/q2-launch` is the task, the thread, and (now) the calendar entry. Everything addresses the same node.
- **Shared permissions.** [ACL](../concepts/security.md#acl) on the node covers all its components. No separate "who can read the thread" policy.
- **Shared realtime.** One [subscription](../concepts/reactivity.md) on the node delivers every change — task status flips *and* new messages.
- **Shared audit.** Every mutation lands in the same [audit trail](../concepts/audit.md), with the same lineage fields.

What you didn't do: translate a thought into the grammar of a database, then translate it back to draw a screen. The grammar is the domain.

## When the split IS real

Sometimes two concepts just aren't the same thing. A task and the user who owns it are different entities with different lifecycles; those are two [nodes](../concepts/nodes.md) connected by a [ref](../concepts/composition.md#node), not one node with two components. The rule of thumb: if deleting one should delete the other, it's a component; if they survive independently, they're separate nodes.

## Next

- [Build a Mod](../guides/create-a-mod.md) — the same mental model, expanded across types/actions/views/seed
- [Composition](../concepts/composition.md) — Component → Node → Tree → Forest, in depth
- [Contexts](../concepts/context.md) — the registry that made two renders possible
- [The Zen of Treenix](../concepts/zen.md) — why the platform was built to let you think like this
