# Quickstart: Todo App in 5 Minutes

Build a working todo list with types, actions, reactive UI, and real-time updates.

**Prerequisites:** Node.js 22+

## 1. Setup

```bash
npx create-treenity my-todo-app
cd my-todo-app
```

The CLI prompts for frontend (yes) and example mod (no — we'll build our own).

Start two terminals:

```bash
npm run dev          # Backend → :3211
npm run dev:front    # Frontend → :3210
```

Open [http://localhost:3210](http://localhost:3210). You should see the admin UI with a tree sidebar.

## 2. Your First Mod

Treenity code lives in **mods** — self-contained modules under `mods/`. Each mod has:

```
mods/todo/
├── types.ts    — data types + actions (shared)
├── seed.ts     — initial data
├── view.tsx    — React view (frontend only)
├── server.ts   — server entry (imports types + seed)
└── client.ts   — client entry (imports types + view)
```

The server auto-discovers `server.ts`, the frontend loads `client.ts` via explicit imports in `load-client.ts`.

### types.ts — Define Your Data

```typescript
import { registerType } from '@treenity/core/comp';

class TodoItem {
  title = '';
  done = false;

  /** @description Toggle done state */
  toggle() {
    this.done = !this.done;
  }
}

registerType('todo.item', TodoItem);
export { TodoItem };
```

**What just happened:**

- `TodoItem` is a plain class. Fields = data schema. Methods = actions.
- `registerType('todo.item', TodoItem)` stamps `$type`, registers the class, and auto-discovers `toggle()` as an executable action.
- The `toggle` method runs server-side inside an Immer draft — `this` is the node being mutated, patches are generated automatically.

Now the list that creates items:

```typescript
class TodoList {
  title = 'My Todos';

  /** @description Add a new todo item */
  async add(data: { title: string }) {
    if (!data.title?.trim()) throw new Error('Title required');
    const { node, store } = (await import('@treenity/core/comp')).getCtx();
    const id = Date.now().toString(36);
    await store.set({
      $path: `${node.$path}/${id}`,
      $type: 'todo.item',
      title: data.title.trim(),
      done: false,
    });
  }
}

registerType('todo.list', TodoList);
export { TodoList };
```

`getCtx()` gives you access to the current node and the store — available inside any action method.

### seed.ts — Initial Data

```typescript
import { type NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('todo', 'seed', [
  { $path: 'todo', $type: 'dir' },
  { $path: 'todo/list', $type: 'todo.list', title: 'My Todos' },
  { $path: 'todo/list/1', $type: 'todo.item', title: 'Read the quickstart', done: true },
  { $path: 'todo/list/2', $type: 'todo.item', title: 'Build something', done: false },
] as NodeData[]);
```

Prefabs named `'seed'` are auto-deployed at server startup. Idempotent — existing nodes are skipped.

### server.ts + client.ts — Entry Points

```typescript
// server.ts
import './types';
import './seed';

// client.ts
import './types';
import './view';
```

That's it. No manifest, no config. The server walks `mods/*/server.ts` on startup. For the frontend, add `import '../../../mods/todo/client';` to `packages/react/src/load-client.ts`.

## 3. See It Work

Generate JSON schemas so the admin UI knows your types:

```bash
npm run schema
```

Restart the dev server (it watches files, but new mods need a restart).

Navigate to [http://localhost:3210/t/todo/list](http://localhost:3210/t/todo/list).

Without a custom view, you'll see the **Inspector** — a generic editor showing fields and action buttons. Click "add" to test creating items, "toggle" on any item to flip its done state.

This already works: typed data, validated actions, real-time updates, persistence to disk. No view code needed.

## 4. Add a Custom View

Create `view.tsx` for a proper UI:

```tsx
import { register, type NodeData } from '@treenity/core/core';
import { usePath, useChildren } from '@treenity/react/hooks';
import { useState } from 'react';
import { TodoItem, TodoList } from './types';

function TodoListView({ value }: { value: NodeData }) {
  const list = usePath(value.$path, TodoList);
  const children = useChildren(value.$path, { watch: true, watchNew: true });
  const [draft, setDraft] = useState('');

  const handleAdd = async () => {
    if (!draft.trim()) return;
    await list.add({ title: draft });
    setDraft('');
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h2 className="text-xl font-bold mb-4">{list.title}</h2>

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 border rounded px-3 py-1.5 text-sm"
          placeholder="What needs to be done?"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <button
          className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm"
          onClick={handleAdd}
        >Add</button>
      </div>

      <ul className="space-y-1">
        {children.map(child => (
          <TodoItemRow key={child.$path} value={child} />
        ))}
      </ul>
    </div>
  );
}

register('todo.list', 'react', TodoListView as any);
```

```tsx
function TodoItemRow({ value }: { value: NodeData }) {
  const item = usePath(value.$path, TodoItem);

  return (
    <li
      className="flex items-center gap-2 px-3 py-2 rounded
        hover:bg-neutral-100 cursor-pointer"
      onClick={() => item.toggle()}
    >
      <span className={`w-4 h-4 rounded border flex items-center
        justify-center text-xs ${item.done
          ? 'bg-blue-600 border-blue-600 text-white'
          : 'border-neutral-300'}`}>
        {item.done ? '✓' : ''}
      </span>
      <span className={item.done ? 'line-through text-neutral-400' : ''}>
        {item.title}
      </span>
    </li>
  );
}

register('todo.item', 'react', TodoItemRow as any);
```

**Key patterns:**

- `usePath(path, TodoList)` returns a **TypeProxy** — reactive fields (`list.title`) + async action methods (`list.add()`). Reads update when the node changes. Methods call the server via tRPC.
- `useChildren(path, { watch: true, watchNew: true })` returns a reactive list of child nodes, auto-updating via SSE.
- `register('todo.list', 'react', Component)` binds the component to the type. The `<Render>` component resolves it automatically.
- Tailwind classes for styling — no inline styles.

Refresh the page. Your custom view replaces the Inspector.

## 5. What You Get for Free

Without writing any extra code, your todo list now has:

| Feature | How |
|---|---|
| **Persistence** | Nodes saved to `./data/` as JSON files |
| **Real-time sync** | SSE subscriptions — open two tabs, changes sync |
| **Type validation** | JSON schemas auto-generated from classes |
| **ACL** | Per-node access control (public/authenticated/admin) |
| **AI access** | Every node readable via MCP — Claude can query your todos |
| **Actions API** | `toggle()` and `add()` callable from React, Telegram, CLI |
| **Admin UI** | Inspector as fallback for any node without a custom view |

## Core Concepts

### Nodes = Addressable Typed Data

```
{ $path: '/todo/list/abc', $type: 'todo.item', title: 'Buy milk', done: false }
```

Every node has a path (address) and type (schema + behavior). Children are discovered by path prefix query — `/todo/list/*` finds all items.

### Actions = Typed Server Methods

Class methods become server-side actions. They run inside an Immer draft — mutate `this` freely, patches are generated and broadcast to subscribers.

```typescript
// Define
class TodoItem {
  done = false;
  toggle() { this.done = !this.done; }
}

// Call from React
const item = usePath('/todo/list/1', TodoItem);
await item.toggle();  // → tRPC mutation → Immer patch → SSE broadcast
```

### Context = Multi-Surface Rendering

The same node renders differently depending on context:

```typescript
register('todo.item', 'react', TodoItemView);     // Browser
register('todo.item', 'text', (node) => ...);      // Plain text / CLI
register('todo.item', 'telegram', TelegramView);   // Telegram bot
```

One type, many surfaces. No glue code.

## Next Steps

- **Add more actions** — `remove()`, `rename()`, `reorder()` methods on your classes
- **Compose types** — add a `todo.tag` component to items for categorization
- **Mount data** — connect MongoDB or REST APIs with `t.mount.mongo` / `t.mount.overlay`
- **Build for Telegram** — register `telegram` context handlers, same data
- **Read the [architecture](../CLAUDE.md)** — three primitives, layer model, design decisions
