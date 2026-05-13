---
name: treenix-view-builder
description: Create reactive React views for Treenix types using View<T>, useActions, useChildren, and the register API.
version: 2.0.0
author: treenix-ai
tags: [treenix, low-code, react, views, hooks, tailwind]
---

# Treenix View Builder Skill

Build reactive React views for Treenix nodes. **`value` arrives already reactive and typed** — read fields directly, call actions via `useActions(value)`. Subscriptions update automatically via SSE.

## When to Use

- User wants to build a React UI for a Treenix node type
- User asks to make a view that shows and updates node data
- User wants to call actions (class methods) from a React component
- User needs a list view that shows children and updates in real time

## Core Imports

```typescript
import { view, useActions, useChildren, type View } from '@treenx/react';
import { MyItem, MyList, CafeOrder } from './types';
```

## View Signature — Always `View<T>`

```tsx
const OrderView: View<CafeOrder> = ({ value }) => {
  const actions = useActions(value);
  return (
    <div className="p-4">
      <h3 className="text-lg font-bold">{value.status}</h3>
      <button onClick={() => actions.complete()}>Done</button>
    </div>
  );
};

view(CafeOrder, OrderView);
```

- `View<T>` types `value: T` — all fields autocompleted, no `as` casts.
- `value` is the **already reactive snapshot** delivered by `<Render>`. Field reads (`value.title`) re-render automatically when the node changes via SSE.
- `useActions(value)` returns a typed proxy with the class's methods. Every call routes to `execute(path, methodName, data)` on the server.

## Reading Fields — Just `value.X`

```tsx
const TodoItemView: View<TodoItem> = ({ value }) => {
  const actions = useActions(value);
  return (
    <li onClick={() => actions.toggle()}>
      <input type="checkbox" checked={value.done} readOnly />
      <span className={value.done ? 'line-through' : ''}>{value.title}</span>
    </li>
  );
};
```

**Anti-pattern — NEVER do this inside a View:**

```tsx
// ❌ WRONG — `usePath(value.$path, Class)` inside View<T> is redundant.
// `value` is already the reactive proxy; this adds an extra subscribePath
// and another resolve. The pattern was copied across 20+ files and broke
// typing/reactivity expectations.
const BadView: View<TodoItem> = ({ value }) => {
  const { data: item } = usePath(value.$path, TodoItem);  // ❌ remove
  if (!item) return null;                                  // ❌ dead code, Render guarantees value
  return <span>{item.title}</span>;
};

// ✅ RIGHT
const GoodView: View<TodoItem> = ({ value }) => {
  return <span>{value.title}</span>;
};
```

## Calling Actions — `useActions(value)`

`useActions(value)` returns a `Actions<T>` proxy:

```tsx
const TodoListView: View<TodoList> = ({ value, ctx }) => {
  const actions = useActions(value);
  const { data: children } = useChildren(ctx!.path, { watch: true, watchNew: true });
  const [draft, setDraft] = useState('');

  const handleAdd = async () => {
    if (!draft.trim()) return;
    await actions.add({ title: draft });
    setDraft('');
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h2 className="text-xl font-bold mb-4">{value.title}</h2>
      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 border rounded px-3 py-1.5 text-sm"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <button className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm" onClick={handleAdd}>
          Add
        </button>
      </div>
      <ul className="space-y-1">
        {children.map(child => (
          <TodoItemView key={child.$path} value={child} />
        ))}
      </ul>
    </div>
  );
};
```

- `useActions(value)` is **opt-in** — only call it when the view actually triggers methods.
- For data-only views (display, no mutations), don't import `useActions` at all.

## Streaming Actions (Async Generators)

To consume an `async *` action, go through the **typed `usePath` proxy** — `useActions(value)` types every method as `Promise<unknown>` and cannot drive a streaming call. `usePath(path, Class)` returns `Query<TypeProxy<T>>`, and `.data.foo()` carries the `AsyncIterable<Y>` declared by `Actions<T>`:

```tsx
const AgentView: View<MyAgent> = ({ value, ctx }) => {
  const { data: agent } = usePath(ctx!.path, MyAgent);
  const [output, setOutput] = useState('');

  const handleRun = async () => {
    setOutput('');
    for await (const chunk of agent.generate({ prompt: 'hello' })) {
      setOutput(prev => prev + chunk);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <button onClick={handleRun}>Run</button>
      {output && <pre>{output}</pre>}
    </div>
  );
};
```

This is the one place where reaching for `usePath(ctx!.path, Class)` **inside** the view of that very type is correct — its sole job is to give you the typed action proxy that drives a stream.

## useChildren — Reactive Children List

```tsx
const MyListView: View<MyList> = ({ value, ctx }) => {
  const { data: children } = useChildren(ctx!.path, { watch: true, watchNew: true });
  return (
    <ul>
      {children.map(child => (
        <MyItemRow key={child.$path} value={child} />
      ))}
    </ul>
  );
};
```

Options:
- `watch: true` — subscribe to updates on existing children
- `watchNew: true` — subscribe to new children appearing
- `limit: 50` — cap the number returned

Children come as `NodeData[]`. Pass each child as `value` to a child View — Render gives the child its own reactive `value` via the registry.

## When `usePath` Is Still Correct

`usePath` exists for paths **outside** the current view's `value`:

```tsx
// ✅ Reading a related node by path you computed / got from elsewhere
const { data: target } = usePath(value.targetRef ?? null);

// ✅ Typed read of a foreign node
const { data: other } = usePath('/some/other/path', OtherType);

// ✅ Reading an additional component by key (the 3rd argument)
const { data: chat } = usePath(ctx!.path, MetatronChat, 'chat');
```

`usePath` always returns `Query<T>` — destructure `.data` to read the value, the rest is `loading`, `error`, `stale`, `refetch`.

### Paths come from `ctx`, not `value`

`value: T` in `View<T>` is typed as the **component shape** (e.g. `LandingHero` with `title`, `subtitle`). `$path` lives on `NodeData`, not on `T`. To get the path, use `ctx!.path`:

```tsx
// ❌ TS error — `value: LandingHero` has no `$path`
useChildren(value.$path);

// ✅
const { data: children } = useChildren(ctx!.path);
```

At runtime `value` IS NodeData with $path, but TS sees only T. Reach for `ctx!.path` instead of casting.

### Rule of thumb

If `View<T>` and the Class arg == `T` (same type) → don't need `usePath`, read `value.X` + `useActions(value)`.

For 3-arg `usePath(ctx!.path, OtherClass, 'key')` — accessing an **additional component** by key — that's the explicit sub-component form. Use it only if you really have a sub-component under a known key. The cleaner pattern is to make the sub-component a **child node** instead, so it gets its own View<T> with direct `value` + `useActions`.

## view — Binding Views to Types

Use the `view()` helper from `@treenx/react`. Pass the **Class** as the first arg — it's type-checked end-to-end and tells the registry which class to instantiate for typing the proxy.

```typescript
view(MyModItem, MyItemView);                  // 'react'         — default context
view(MyModList, MyListView);                  // 'react'
view.list(MyModItem, MyItemListRow);          // 'react:list'    — shortcut
view.compact(MyModItem, MyItemCompactView);   // 'react:compact' — shortcut
view.edit(MyModItem, MyItemEditor);           // 'react:edit'    — shortcut
view(MyModItem, 'kanban', MyItemKanbanCard);  // 'react:kanban'  — any custom context
view.universal(MyModItem, IsoView);           // 'react' + 'site' for SSR
```

`view()` is sugar around the core `register()` registry — same effect, typed signature, no `'react:'` prefix to remember. Reach for raw `register('mymod.item', 'react', view)` only as a string-keyed escape hatch (e.g. wiring across packages without importing the class).

Context fallback: exact → default@same-ctx → strip suffix → recurse → null.

## Using `ctx` — Path, Node, Generic Execute

`View<T>` props are `{ value, onChange?, ctx? }`. `ctx` is the runtime metadata for the rendered node:

```typescript
type ViewCtx = {
  node: NodeData;                                    // raw node (has $path, $type, all components)
  path: string;                                      // node.$path (or `${$path}#${key}` if rendering a sub-component)
  execute(action: string, data?): Promise<unknown>;  // generic untyped execute
};
```

### When you need `ctx`

**1. Passing path to a non-View helper component** — when a helper needs `$path` but its signature is `value: T` (not `T & NodeData`):

```tsx
const ThankaSpiral: View<ThankaTimeline> = ({ value, ctx }) => (
  <ThankaCanvas value={value} path={ctx!.path} layout="spiral" />
);

// canvas.tsx helper (not a registered View):
function ThankaCanvas({ value, path }: { value: ThankaTimeline; path: string }) {
  const { data: children } = useChildren(path);
  // ...
}
```

**2. Reading raw `$path` / `$type` metadata** — `value: T` doesn't include `NodeData` fields, so reach for `ctx?.node` or `ctx?.path`:

```tsx
const TaskRow: View<BoardTask> = ({ value, ctx }) => (
  <li data-path={ctx?.path} className="...">
    {value.title}
  </li>
);
```

**3. Propagating `onChange`** — `onChange` is its own prop, not under `ctx`. Forward it directly:

```tsx
const FieldRow: View<MyType> = ({ value, onChange }) => (
  <Input value={value.title} onChange={v => onChange?.({ title: v })} />
);
```

### Prefer `useActions(value)` over `ctx?.execute`

```tsx
// ❌ untyped, no autocomplete
ctx?.execute('toggle');

// ✅ typed via Actions<T>
const actions = useActions(value);
actions.toggle();
```

`ctx?.execute` is the generic escape hatch — use only for dynamic action names (`ctx?.execute(actionName, data)` where `actionName` comes from a variable).

### `ctx` is non-null inside `<Render>`

Render always passes `ctx` (built from `viewCtx(value)`). The `?` in the type is for raw direct invocation outside Render — extremely rare. In registered views `ctx!.path` is safe.

## Styling — Theme Tokens First

Treenix uses standard shadcn + Tailwind v4. Compose **semantic tokens**, never hardcoded palette. See [docs/concepts/theming.md](docs/concepts/theming.md) for full reference.

### Required tokens

| Need | Class |
|---|---|
| App canvas | `bg-background` |
| Default text | `text-foreground` |
| In-flow card / panel | `bg-card text-card-foreground` |
| Floating surface (menu, dialog, popover) | `bg-popover text-popover-foreground` |
| Brand action | `bg-primary text-primary-foreground` |
| Subdued surface | `bg-muted` |
| Subdued text | `text-muted-foreground` |
| Hover / highlight | `bg-accent text-accent-foreground` |
| Errors, destructive | `bg-destructive text-destructive-foreground` |
| Borders | `border border-border` |
| Form field border | `border-input` |
| Focus ring | `ring-2 ring-ring` |

Plus `rounded-md` (8px default) and `font-sans` (Manrope) come from the same theme — don't redeclare.

### Forbidden — break theme switching

```tsx
// ❌ Hardcoded palette — invisible under .dark toggle or light theme
<div className="bg-zinc-900 text-zinc-100 border-zinc-700">

// ❌ Inline hex
<div className="bg-[#151515] text-[#fafafa]">

// ❌ Inline style for color/spacing
<div style={{ background: '#151515', padding: 16 }}>

// ✅ Token-based — adapts to every theme
<div className="bg-card text-foreground border border-border p-4">
```

`style={}` is reserved for **dynamic numeric** values (geometry, transforms, computed dimensions). Never for colours or spacing.

### Reach for shadcn primitives first

Before writing a custom button/input/dialog, use `@treenx/react/ui/<name>`:

```tsx
import { Button } from '@treenx/react/ui/button';
import { Card, CardContent } from '@treenx/react/ui/card';
import { Dialog, DialogContent } from '@treenx/react/ui/dialog';
```

Available: `accordion`, `alert-dialog`, `badge`, `breadcrumb`, `button`, `card`, `checkbox`, `collapsible`, `command`, `dialog`, `drawer`, `dropdown-menu`, `form-field`, `input`, `label`, `pagination`, `popover`, `progress`, `resizable`, `scroll-area`, `select`, `separator`, `sheet`, `skeleton`, `slider`, `sonner`, `switch`, `table`, `tabs`, `textarea`, `toggle`, `toggle-group`, `tooltip`. All already wired to tokens — they honour every theme without extra work.

### Conditional classes — `cn()`

```tsx
import { cn } from '@treenx/react';
<div className={cn('rounded-md p-4', isActive && 'bg-accent text-accent-foreground')}>
```

### Theme switching

```tsx
import { useTheme } from '@treenx/react';
const { theme, setTheme, setCustomTheme } = useTheme();
setTheme('light');  // or 'dark' — toggles .dark class on <html>, persists to localStorage
setCustomTheme({ name: 'cafe', tokens: { '--color-primary': '#fbbf24' } });
```

## Guard Inputs from Node Data

Class defaults seed initial values (`title = ''`, `done = false`), so for required fields with defaults `value.X` is safe. Optional fields (`subtitle?: string`) may be `undefined` — guard via conditional rendering:

```tsx
{value.subtitle && <p>{value.subtitle}</p>}
{value.title?.trim() && <h3>{value.title.trim()}</h3>}
```

**Always check the browser DevTools console after any view change.** Runtime TypeErrors from unguarded data are the #1 source of broken views.

## Common Mistakes

**Do NOT use `tree.set()` from client code.** All mutations go through `useActions(value)`:

```typescript
// WRONG — bypasses business logic, ACL, validation
tree.set({ $path: '/todo/list/abc', $type: 'todo.item', done: true });

// RIGHT
const actions = useActions(value);
await actions.toggle();
```

**Do NOT use `ctx.execute('actionName', data)` with string action names** — untyped, no autocomplete. Use `useActions(value).actionName(data)`.

**Do NOT use `usePath(value.$path, Class)` inside `View<T>`** — see anti-pattern above. `value` is already the reactive snapshot.

**Do NOT add component CSS to `src/front/style.css`.** That file is for the shell only. Put component CSS next to the component file and import from `.tsx`.

**Do NOT call hooks conditionally:**

```tsx
// WRONG
if (!value) return null;
const actions = useActions(value);  // hook called conditionally

// RIGHT — Render guarantees value exists; if you still want a guard, call hook first
const actions = useActions(value);
```

## Deprecated Hooks — Do NOT Use
`useNode`, `useComponent`, `useExecute`, `useComp`, `useAction`, `useStream`. 

## USE
`value` + `useActions(value)` + `useChildren` + `usePath` (for foreign paths only).

## React Gotchas

- **Never dummy state counters** (`const [, setTick] = useState(0)`) — React Compiler optimizes away. Store real values used in render.
- `setHandler(() => fn)` — wrap functions in arrow, otherwise React treats them as updater.
- **Never `useRef(expensiveInit)`** — argument evaluates every render. Use `useState(() => init)`.
- **Never object/array literals in `useState()`/`useRef()`** — allocates every render. Module-level `const` or lazy initializer.
- **Never polling.** Treenix is reactive (SSE watch, subscriptions).

## Type Reference

```typescript
// @treenx/react exports:
type View<T, Extra = {}> = FC<RenderProps<T> & Extra>;
type RenderProps<T> = { value: T; onChange?: ...; ctx?: ViewCtx | null };
type ViewCtx = { node: NodeData; path: string; execute(action, data?): Promise<unknown> };

// useActions returns Actions<T>:
type Actions<T> = {
  [K in keyof T as T[K] extends Function ? K : never]:
    Parameters<T[K]> extends [infer D] ? (data: D) => Promise<unknown> : () => Promise<unknown>
};
```
