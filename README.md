<p align="center">
  <img src="docs/assets/readme-header.svg" alt="Treenix - Fullstack AI-ready Platform" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@treenx/core"><img alt="Treenix 3.0.12" src="https://img.shields.io/badge/Treenix-3.0.12-65B741?style=for-the-badge&labelColor=3b3b3b"></a>
  <a href="https://nodejs.org"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%3E%3D22-65B741?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=3b3b3b"></a>
  <a href="https://discord.gg/peX8CwHQPz"><img alt="Discord chat" src="https://img.shields.io/badge/chat-Discord-65B741?style=for-the-badge&logo=discord&logoColor=white&labelColor=3b3b3b"></a>
</p>

<p align="center">
  <strong>Fullstack Platform.</strong><br />
  ECS-style tree of typed components with context-aware rendering.
</p>

Docs: [Introduction](./docs/index.md) · [Composition](./docs/concepts/composition.md) · [Components](./docs/concepts/components.md) · [Quickstart & Setup](./docs/getting-started/installation.md) · [Tutorial](./docs/getting-started/tutorial.md) · [Thinking in Treenix](./docs/getting-started/thinking-in-treenix.md) · [React Views](./docs/guides/react-views.md) · [API](./docs/api/overview.md)

Write a class. Attach it to a node. Treenix turns it into stored data, editable forms, rendered views, server actions, MCP tools, access rules, realtime updates, and audit events.

Treenix is for building applications as a shared tree of composable nodes. Humans use the app and admin interface. Agents use the same tree through typed actions. Your business logic stays in one place instead of being copied across schema, API, UI, permissions, and agent tools.

## Three Primitives

```typescript
Node      = { $path, $type, ...components }
Component = { $type, ...data }
Context   = (Type, context) => handler
```

In ECS terms, a **Node** is the entity, a **Component** is a typed aspect attached to that entity, and **Contexts** provide the systems around it: React views, actions, services, validation, ACL, text rendering, and agent tools.

Treenix borrows ECS composition without forcing everything into a global game loop. A service can behave like a scoped system over a subtree, a React context can render the same component as a card or editor, and an action can mutate the same node through the validated server pipeline.

## Create an App

```bash
npm create treenix my-app
cd my-app
npm run dev
```

Open `http://localhost:3210`.

## Core Idea

One class defines a component's data and actions:

```typescript
// mods/todo/types.ts
import { getCtx, registerType } from '@treenx/core/comp';

export class TodoItem {
  title = '';
  done = false;
  priority: 'low' | 'normal' | 'high' = 'normal';

  toggle() {
    this.done = !this.done;
  }

  remove() {
    const { node, tree } = getCtx();
    tree.remove(node.$path);
  }
}

registerType('todo.item', TodoItem);
```

Register a React view for the same type:

```tsx
// mods/todo/view.tsx
import { useActions, view } from '@treenx/react';
import { TodoItem } from './types';

view(TodoItem, ({ value }) => {
  const { toggle, remove } = useActions(value);

  return (
    <div>
      <button onClick={() => toggle()}>
        {value.done ? 'Done' : 'Open'}
      </button>
      <span>{value.title}</span>
      <button onClick={() => remove()}>Remove</button>
    </div>
  );
});
```

The type and the view work on the same node. The view reads typed data from `value` and calls typed server actions through `useActions(value)`.

## ECS Composition

Model by attaching capabilities to nodes instead of building inheritance trees or join tables. A task can also be a discussion thread, an AI assignment, a calendar item, and a billing unit because those are separate components on the same addressable entity:

```typescript
{
  $path: '/work/q2-launch',
  $type: 'todo.task',

  // Main component fields live at node level because $type === 'todo.task'.
  title: 'Ship Q2 launch',
  done: false,
  priority: 'high',

  // Additional components attach under named keys.
  thread: {
    $type: 'forum.thread',
    messages: [],
  },
  ai: {
    $type: 'metatron.assignment',
    agent: '/agents/release-manager',
  },
  schedule: {
    $type: 'calendar.entry',
    dueDate: '2026-05-15',
  },
}
```

Each component has its own type, schema, actions, views, and permissions. The node gives them shared identity (`/work/q2-launch`), shared realtime updates, shared audit history, and shared tree placement.

This is the main modeling rule:

- If two pieces of data describe one thing and share lifecycle, put them on one

  node as components.

- If they can live or be deleted independently, make them separate nodes and

  connect them with refs or child paths.

- Add a capability by adding a component. Do not create a subclass just to say

  "task with chat" or "order with AI".

The node itself is its main component. `getComponent(node, TodoItem)` returns the node when `node.$type === 'todo.task'`; named keys are for additional components with their own `$type`.

## Runtime Model

Treenix keeps the same object moving through one pipeline:

| Layer | What happens |
| --- | --- |
| Type | A class defines fields, validation metadata, and actions for a component. |
| Component | Typed aspects attach to nodes by key and can render or react independently. |
| Node | Data lives at a path in the tree, such as `/todos/ship-readme`, with one main component and any number of extras. |
| Context | React views, text renderers, services, ACL, schema, and action handlers resolve by `(Type, context)`. |
| Action | Class methods execute as server-side mutations from UI, services, workflows, or MCP clients. |
| Security | ACL and validation run on reads, writes, subscriptions, and action calls. |
| Realtime | Mutations stream patches to subscribed views and child queries. |
| Audit | The runtime can record who changed what, when, and through which path. |

## Modules

Modules are Types + Views + Services packaged together. A module may define a workflow, a document editor, an MCP adapter, a board, or a domain-specific app.

Current module areas:

| Area | Examples |
| --- | --- |
| Ops | Flow, Board, Brahman, Jitsi |
| Content | Mindmap, Blocks, Doc, Table |
| AI | Tagger, Agent, Whisper, Memory |
| Infra | Row-layout, Backup, MCP, Query |
| Experimental | Org, Grove, Resim |

## Next Steps

- [Quickstart & Setup](./docs/getting-started/installation.md) — create a project and run it locally.
- [Tutorial](./docs/getting-started/tutorial.md) — build a bookmark manager from a Type, actions, seed data, and views.
- [Create a Mod](./docs/guides/create-a-mod.md) — package Types, Views, and Services into a reusable module.
- [React Views](./docs/guides/react-views.md) — register typed views and render children through contexts.

## Community

- GitHub: treenix/treenix-io
- Discord: discord.gg/peX8CwHQPz
- Telegram: t.me/treenix_io
- X: x.com/treenix

## License

[FSL-1.1-MIT](../LICENSE) — Fair Source. Read, use, modify, and redistribute for non-competing purposes. Each version becomes MIT two years after release.
