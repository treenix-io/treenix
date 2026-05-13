## front
React admin SPA — node editor, tree browser, typed hooks, client cache.

### Files
- App.tsx — root layout: Tree sidebar + NodeEditor main panel
- hooks.ts — `usePath`, `useChildren`, `set`, `execute`, `watch`
- context/index.tsx — `<Render>`, `View<T>`, `useActions`, `RenderProps`
- cache.ts — in-memory node cache, subscribePath/subscribeChildren
- trpc.ts — tRPC client setup
- Inspector.tsx — generic component inspector (key-based, not typed)
- AclEditor.tsx — ACL UI

### Conventions
- Inside `View<T>` read fields directly from `value` (Render already provides a reactive snapshot)
- For actions — `useActions(value)` (typed Actions<T>, routes to `execute`)
- `usePath` — only for paths other than `value.$path` (foreign path / 3-arg key form)
- `useChildren(path)` — reactive children list
- No magic `action: 'string'` strings — use `useActions(value).method(data)` instead

### Views — Reading Fields and Calling Actions

Inside `View<T>`, **`value` is already the reactive typed snapshot**. Read fields directly. For actions, opt-in with `useActions(value)`.

```tsx
const CounterView: View<Counter> = ({ value }) => {
  const actions = useActions(value);             // typed Actions<Counter>
  return (
    <button onClick={() => actions.increment()}>
      {value.count}                               // reactive read, re-renders on SSE
    </button>
  );
};
```

- `value.X` — reactive field read. The cache delivers a fresh `value` on every change; subscription happens in `<Render>`, not inside the view.
- `useActions(value)` — `Actions<T>` proxy. Every method call routes to `execute(path, methodName, data)`.
- For data-only views, don't import `useActions` at all.

### Anti-pattern — NEVER inside `View<T>`

```tsx
// ❌ Redundant: `usePath(value.$path, Class)` inside a View duplicates the
// subscription Render already made and double-resolves the same node.
const Bad: View<Counter> = ({ value }) => {
  const { data: c } = usePath(value.$path, Counter);
  if (!c) return null;
  return <span>{c.count}</span>;
};

// ✅ Canonical
const Good: View<Counter> = ({ value }) => <span>{value.count}</span>;
```

- `value.increment()` — `value` has no methods at runtime → TypeError. Use `useActions(value).increment()`.
- `ctx.execute('increment')` — untyped string, no autocomplete. Use `useActions(value).increment()`.

### When `usePath` is still right

For paths **other than the current view's** value:
- `usePath(otherPath)` — read a different node by URI
- `usePath(otherPath, Class)` — typed proxy for a different node
- `usePath(value.$path, Class, 'key')` — read an additional component by key (3rd argument changes semantics: `getComponent(node, cls, key)`)

### View Contexts — content vs chrome

The contexts `react:list`, `react:card`, `react:icon` are the **content** of a node for the matching slot (list row, card, icon). The slot itself (border, padding, hover, click-to-navigate, fixed width, grid layout) is the responsibility of the **observer** that renders the collection.

```tsx
// Item view = ONLY content (fragment, or a div with flex-col)
view.list(MyType, ({ value }) => (
  <>
    <Icon />
    <span>{value.title}</span>
  </>
));

view.card(MyType, ({ value }) => (
  <>
    <header>{value.title}</header>
    <p>{value.summary}</p>
  </>
));
```

The **observer** wraps each item via `<RenderChildren items ctx />` from `@treenx/react/mods/editor-ui/list-items`:

```tsx
import { RenderChildren } from '@treenx/react/mods/editor-ui/list-items';

<RenderChildren items={children} ctx="list" />   // or 'card' | 'icon' | 'react'
<RenderChildren items={[]} ctx="card" empty={<EmptyState/>} />
```

For a single item — `<RenderItem value ctx />`.

**NEVER in item views:**
- ❌ `<button onClick={navigate}>...</button>` — click/navigation belongs to the observer
- ❌ `border`, `rounded-md`, `bg-card`, `px-3 py-2`, `hover:bg-accent/50` — chrome belongs to the observer
- ❌ `w-[200px]` — width belongs to the observer
- ❌ chevron `›`, decorative trailing affordances — observer-owned

**Defaults:** `default`, `dir`, `ref` are already registered for `react:list` / `react:card` / `react:icon` as content-only fallbacks. Register your own only when specific content is needed.

**Registering content-only items:**
- `view.list(Type, Item)`
- `view.card(Type, Item)` — currently via `view(Type, 'card', Item)` or `register(Type, 'react:card', Item)`
- `register(Type, 'react:icon', Item)`

**What the observer should do to switch views:**
```tsx
const [ctx, setCtx] = useState<ChildCtx>('list');
return (
  <>
    <Switcher value={ctx} onChange={setCtx} />
    <RenderChildren items={children} ctx={ctx} />
  </>
);
```

See [editor-ui/dir-view.tsx](mods/editor-ui/dir-view.tsx) — the reference observer with a switcher.
