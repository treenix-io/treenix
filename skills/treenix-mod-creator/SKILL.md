---
name: treenix-mod-creator
description: Scaffold Treenix mods — typed classes (schema + actions), seed prefabs, server/client entry points. Use when creating a new mod, adding a type, action, or seed.
version: 2.0.0
author: treenix-ai
tags: [treenix, low-code, mod, types, seed, scaffold, ecs]
---

# Treenix Mod Creator

A Treenix mod = typed nodes + actions + seed data + (optional) React views. Class fields are the schema. Class methods are the server-side actions. Both are picked up automatically — `mods/*/server.ts` is loaded by the engine, `mods/*/client.ts` is wired into the frontend bundle by the vite plugin.

## When to use

- Create a new mod (data type + actions + seed)
- Add a new type or action to an existing mod
- Add seed data / prefabs
- Wire server or client entry points

For React views beyond a one-line snippet, defer to the `treenix-view-builder` skill.

## How to behave

- Narrate progress in plain language as you go.
- When finished, summarise what was built and how to use it.

## File layout

```
mods/{name}/
  types.ts      classes (schema + actions), registerType
  server.ts     server entry: imports types, service, seed
  client.ts     client entry: imports types, react
  seed.ts       registerPrefab — initial data
  react.tsx     React views (optional, preferred filename)
  service.ts    long-running services (optional)
  *.test.ts     node:test tests
  schemas/      auto-generated JSON Schemas — never edit by hand
```

**Autoload — no manual wiring.**
- **Server.** The engine walks each `mods/{name}/` directory. If `server.ts` exists, it is imported; otherwise the loader imports `types.ts`, `seed.ts`, and `service.ts` (whichever are present).
- **Client.** The vite plugin discovers `mods/*/client.ts` and stitches it into the SPA bundle via the `virtual:mod-clients` module. If `client.ts` is absent, the plugin falls back to `types.ts` + `react.tsx` (or legacy `view.tsx`).
- Nothing to edit in `packages/react/src/*` to register a new mod.

## types.ts

Class = schema + actions. Field defaults declare the schema. Methods become actions.

```typescript
import { getCtx, registerType } from '@treenx/core';
import { makeNode } from '@treenx/core';

export class Task {
  /** @title Title */
  title = '';

  /** @title Status */
  status: 'todo' | 'doing' | 'done' = 'todo';

  /** @title Assignee user path @format path */
  assignee = '';

  /** @description Start the task */
  start() {
    if (this.status !== 'todo') throw new Error('Can only start a todo task');
    this.status = 'doing';
  }

  /** @description Mark task done */
  complete() {
    if (this.status !== 'doing') throw new Error('Can only complete a doing task');
    this.status = 'done';
  }

  /** @description Assign to a user */
  assign(data: { userId: string }) {
    if (!data.userId) throw new Error('userId required');
    this.assignee = data.userId;
  }
}

export class TaskBoard {
  /** @title Board title */
  title = 'Tasks';

  /** @description Create a new task on this board */
  async create(data: { title: string }) {
    if (!data.title?.trim()) throw new Error('Title required');
    const { node, tree } = getCtx();
    const id = Date.now().toString(36);
    await tree.set(makeNode(`${node.$path}/${id}`, 'tasks.task', {
      title: data.title.trim(),
      status: 'todo',
      assignee: '',
    }));
  }
}

registerType('tasks.task', Task);
registerType('tasks.board', TaskBoard);
```

### Rules for types.ts

**Fields = schema.** Initialise every field that is required by the runtime — the default declares both the type and the starting value. Optional fields (declared with `?` or `| undefined`) may omit a default.

**Methods = actions.** `registerType` scans the prototype and registers each method as the `action:{name}` context handler. Regular (non-generator) methods run server-side inside an Immer draft — mutate `this` freely, the diff broadcasts via SSE. Generator actions are different — see below.

> Use prototype method syntax (`foo() {}`, `async foo() {}`, `async *foo() {}`). Arrow-function class fields (`foo = () => { ... }`) are not on the prototype, so `registerType` will not register them as actions — they still produce a schema entry but have no runtime handler.

**`node.$type` IS the primary component.** Main-component fields live at the **node level**, not in a sub-object:

```typescript
// WRONG — fields buried in a sub-object, getComponent ignores them
{ $path: '/x', $type: 'tasks.task', task: { $type: 'tasks.task', title: 'a' } }

// RIGHT — fields on the node
{ $path: '/x', $type: 'tasks.task', title: 'a', status: 'todo' }
```

Named keys are for **additional** components (different `$type` than the node).

**Action signature.** Methods receive `(data, deps?)`:

```typescript
/** @description Confirm at a target order */
async confirm(data: { force?: boolean }, deps: { order: { status: string } }) {
  if (!data.force && deps.order.status !== 'pending') throw new Error('Order not pending');
  this.confirmed = true;
}
```

- `data` — first argument, the typed input from the client / visual editor. Omitted at the call site → `{}` at runtime, not `undefined`.
- `deps` — second argument, populated by the `needs` resolver (see below).
- For a deps-only action declare `(_data: unknown, deps: ...)` to match the runtime shape.

**`getCtx()` inside actions** returns the execution context:

```typescript
type ExecCtx = { node: NodeData; tree: Tree; signal: AbortSignal; [k: string]: unknown };
```

- `node` — current node. In normal write actions this is an Immer draft you can mutate; in `@read`-annotated actions it is a readonly proxy.
- `tree` — the Tree (read/write any path via `tree.get`, `tree.set`, `tree.getChildren`, etc.)
- `signal` — `AbortSignal` for cancellation.
- `getCtx()` throws if called outside an action context.

**Node creation.** Use `makeNode(path, type, data, components?)` from `@treenx/core` to build a `NodeData` object, then persist it with `tree.set(...)`. Never assemble `{ $path, $type, ... }` by hand — `makeNode` validates `$`-prefixed names and normalises the type.

**Async actions** are fine. Errors thrown propagate to the caller as tRPC errors.

**Generator actions** stream chunks to the client over the same subscription:

```typescript
async *stream(): AsyncGenerator<string> {
  yield 'First';
  yield 'Second';
}
```

`registerType` detects `async function*` and marks the action as `stream: true` automatically.

Generator actions run **without an Immer draft** — `this` is the live component, but no diff is collected. If a streaming action must change persisted state, write through `tree.set(...)` or `tree.patch(...)` from `getCtx()` explicitly.

Consuming the stream from the client (typed `usePath` proxy, not `useActions`) is covered in the `treenix-view-builder` skill.

**Reading other nodes** inside an action:

```typescript
async transfer(data: { to: string; amount: number }) {
  const { tree } = getCtx();
  const target = await tree.get(data.to);
  if (!target) throw new Error(`Not found: ${data.to}`);
  this.balance -= data.amount;
}
```

**Composition over new types.** Don't create a new type for a small variation — attach an additional component on a named key:

```typescript
await tree.set(makeNode('/board/data/task-1', 'board.task', {
  title: 'Fix login',
  status: 'todo',
}, {
  chat: { $type: 'metatron.chat' },
  thread: { $type: 'forum.thread' },
}));
```

**`needs` injection — siblings and cross-node deps.** Declared as `static needs` on the class. The resolver fetches dependencies before the action runs and passes them as the second method argument.

```typescript
import type { NodeData } from '@treenx/core';
import { registerType } from '@treenx/core';

class OrderLine {
  quantity = 1;
  price = 0;
  confirmed = false;

  static needs = {
    // 'confirm' needs sibling 'order' component, and parent's 'invoice' child
    confirm: ['order', '../invoice'],
  };

  confirm(_data: unknown, deps: { order: { status: string }; invoice: NodeData }) {
    if (deps.order.status !== 'pending') throw new Error('Order not pending');
    this.confirmed = true;
  }
}

registerType('cafe.order.line', OrderLine);
```

Pattern syntax:
- `sibling-name` — additional component on the same node
- `@fieldName` — follow a path stored in a field on this component
- `/abs/path`, `./rel/path`, `../rel/path` — fetch a specific node
- `/abs/path/*`, `./rel/*`, `../rel/*` — fetch children (returns `NodeData[]`). The base must be absolute or `./`/`../` — bare names like `items/*` fail at resolve time.

**`registerType` options.** Third argument:

```typescript
registerType('tasks.task', Task, {
  override: true,                       // unregister existing handlers first
  needs: ['parent'],                    // '*' fallback — used by actions without their own `static needs` entry
  ports: {
    complete: { pre: ['status'], post: ['status', 'completedAt'] },
  },
  noOptimistic: ['publish'],            // disable optimistic UI for these actions
});
```

### Signature Duality

The TypeScript signature of `data` is the **single source of truth** for code and the visual graph editor:

```typescript
addItem(data: { item: string; price: number }) { ... }
```

- Primitives (`number`, `string`, `boolean`) → form fields in the Inspector
- Class-typed **fields** on the component become **ports** in the visual editor (auto-detected `refType`); method arguments are serialised by structural schema, so wire references through class fields rather than method parameters
- `?` → optional field
- JSON Schema is generated from the signature — never hand-write it.

### JSDoc annotations

| Tag           | Where    | Effect                                                                                                        |
|---------------|----------|---------------------------------------------------------------------------------------------------------------|
| `@title`      | field    | Label in Inspector / forms                                                                                    |
| `@format`     | field    | Widget hint: `email`, `tel`, `url`, `uri`, `password`, `image`, `color`, `date`, `date-time`, `timestamp`, `path`, `tags`, `textarea`, `integer`, `tstring` |
| `@description`| method   | Action label + tooltip in the Inspector                                                                       |
| `@pre`        | method   | Design-by-Contract precondition (warning-only)                                                                |
| `@post`       | method   | Design-by-Contract postcondition (warning-only)                                                               |

### Type naming

- Separator: `.` only — never `/`, `@`, or `:`
- No dot = core built-in: `dir`, `ref`, `root`, `user`, `type`, `mount-point`
- `t.*` = Treenix infrastructure: `t.mount.fs`, `t.mount.mongo`
- `{namespace}.*` = your mod: `tasks.task`, `cafe.order.line`
- Pattern: `{namespace}.{category}.{name}`. The namespace must be unique per mod.

## seed.ts

`registerPrefab(modName, prefabName, nodes)` registers initial data. Prefab named `'seed'` is **auto-deployed at server startup** when no seed filter is configured, or when the mod name appears in `root.json` under `"seeds"`. In tenant mode (`TENANT` env set) only core-tier seeds deploy unless the mod is explicitly listed. Idempotent — existing nodes are skipped, restarts are safe.

```typescript
import { registerPrefab } from '@treenx/core/mod';

registerPrefab('tasks', 'seed', [
  { $path: 'tasks', $type: 'dir' },
  { $path: 'tasks/board', $type: 'tasks.board', title: 'My Tasks' },
]);

// Additional named prefabs deploy on demand via the `deploy_prefab` MCP tool
registerPrefab('tasks', 'demo', [
  { $path: 'tasks', $type: 'dir' },
  { $path: 'tasks/board', $type: 'tasks.board', title: 'Demo' },
  { $path: 'tasks/board/1', $type: 'tasks.task', title: 'Write tests', status: 'todo', assignee: '' },
  { $path: 'tasks/board/2', $type: 'tasks.task', title: 'Ship it',     status: 'doing', assignee: '' },
]);
```

Paths in seed entries are relative; for the `seed` prefab they resolve to absolute paths at deploy time.

## server.ts

```typescript
import './types';
import './service';   // omit if no service.ts
import './seed';
```

Order matters — types must be registered before seed deploys.

## client.ts

```typescript
import './types';
import './react';     // omit if no UI
```

That's it. The vite plugin discovers this file automatically; no further registration is needed.

## react.tsx (optional)

Register a typed React view via the `view()` helper:

```tsx
import { view, useActions, type View } from '@treenx/react';
import { Task } from './types';

const TaskView: View<Task> = ({ value }) => {
  const actions = useActions(value);
  return <button onClick={() => actions.start()}>{value.title}</button>;
};

view(Task, TaskView);                  // context 'react' — the default
// view.list(Task, TaskItem)           // 'react:list'    — shortcut
// view(Task, 'kanban', KanbanCard)    // 'react:kanban'  — any custom context
```

That's the scaffolding bit. **Anything beyond — field reads, hooks, render contexts, content-vs-chrome rules, theming, useDraft — is `treenix-view-builder`'s territory. Use that skill for view work.**

## Mutations: actions, not set

| Caller                                | What to use                                                |
|---------------------------------------|------------------------------------------------------------|
| Client (React view, browser)          | `useActions(value).foo(data)`                              |
| Server action body                    | mutate `this` directly (Immer draft)                       |
| Server action creating a node         | `await tree.set(makeNode(path, type, data, components?))`  |
| Seed prefab                           | declarative array passed to `registerPrefab`               |
| Admin / migration script              | `tree.set(makeNode(...))`                                  |

**Never** `tree.set()` from client code. Always go through actions.

## Imports

- Inside a package — Node.js native `imports`: `import { x } from '#core';`
- Across packages — full name: `import { registerType } from '@treenx/core';`
- Never `require()`, never `@/` aliases, never re-export wrappers — fix imports at source.

## Schemas

Auto-generated on dev server startup from class fields + JSDoc, written to `mods/{name}/schemas/*.json`.

- **Never edit `schemas/*.json` by hand.** Change the TS class.
- Force regen without restart: `npm run schema`.

## Errors

- Fix root cause, never patch downstream tolerance.
- No fallback masking: `x = response?.value || []` is WRONG — validate and throw.
- No empty `catch`. Catch only what you can handle. Always log.
- Never silently return null / zero / empty on failure — propagate.
- Frontend changes → check the browser console: zero errors, zero warnings.

## TypeScript

- Strict, ES2022, ESM.
- **Never** `as any`. If types don't fit, fix the types.
- **Never** `as` for type widening. Use type guards or generics.
- Allowed casts: `as const`, narrowing (`as 'idle'`).

## Tests

- `node:test`, run via `npm test` (passes `--conditions development` so `#*` resolves to `src/`).
- Assert contracts, not messages. `e.code === 'NOT_FOUND'`, not `/Not found/`.
- `assert.rejects(fn, predicate)` over `try/catch + assert.fail`.
- Every `it()` asserts at least once.
- Bug fix → regression test on the exact broken scenario.
- Restore mutated globals (`process.env`, `globalThis.fetch`) in `afterEach`.

## Workflow

1. Search existing types — `catalog`, `search_types` (Treenix MCP). Reuse before creating.
2. Write tests first.
3. Implement classes + `registerType`.
4. Seed via `registerPrefab` if needed.
5. `npm test` — green.
6. Schemas regenerate on dev server start (or `npm run schema`).
7. View with `view()` if UI is needed.
8. Check browser console — zero errors.
9. Granular commit: one logical change, one commit.

