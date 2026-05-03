## front
React admin SPA — node editor, tree browser, typed hooks, client cache.

### Файлы
- App.tsx — root layout: Tree sidebar + NodeEditor main panel
- hooks.ts — useNode, useChildren, useComponent, useAction, **useComp**, **useExecute**
- cache.ts — in-memory node cache, subscribePath/subscribeChildren
- trpc.ts — tRPC client setup
- Inspector.tsx — generic component inspector (key-based, not typed)
- AclEditor.tsx — ACL UI

### Конвенции
- **useComp(path, Class, key?)** — typed reactive proxy: data live, methods → trpc.execute.mutate
- **useExecute()** — stable callback for node-level/generic actions
- No magic `action: 'string'` in views — use useComp methods instead
- useNode/useChildren remain for raw node/children access

### Typed Actions in Views — Two Patterns

**Pattern 1: `useActions(value)`** — typed proxy from View props:
```tsx
const CounterView: View<Counter> = ({ value }) => {
  const actions = useActions(value)     // Actions<Counter> — typed!
  return <button onClick={() => actions.increment()}>+</button>
}
```
- `Actions<T>` extracts methods from T (the Class type) → fully typed autocomplete
- Runtime: Proxy routes every call to `ctx.execute(methodName, data)`
- Requires `$node` symbol on value (set automatically by the rendering pipeline)

**Pattern 2: `usePath(path, Class)`** — typed proxy with data + actions:
```tsx
const CounterView: View<Counter> = ({ ctx }) => {
  const counter = usePath(ctx!.path, Counter)  // TypeProxy<Counter>
  counter.count        // typed data read
  counter.increment()  // typed action call
}
```
- `TypeProxy<T>` merges data fields + methods in one proxy
- Data → `getComponent(node, cls)`, methods → `trpc.execute.mutate`

**НИКОГДА:**
- `value.increment()` — value is plain data at runtime, no methods → TypeError
- `ctx.execute('increment')` — untyped string, no autocomplete

### View Contexts — содержимое vs chrome

Контексты `react:list`, `react:card`, `react:icon` — это **содержимое** ноды для соответствующего слота (строка списка, карточка, иконка). Сам слот (border, padding, hover, click-to-navigate, фиксированная ширина, layout сетки) — ответственность **наблюдателя**, который рендерит коллекцию.

```tsx
// Item view = ТОЛЬКО content (фрагмент или div c flex-col)
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

**Наблюдатель** оборачивает каждый элемент через `<RenderChildren items ctx />` из `@treenx/react/mods/editor-ui/list-items`:

```tsx
import { RenderChildren } from '@treenx/react/mods/editor-ui/list-items';

<RenderChildren items={children} ctx="list" />   // или 'card' | 'icon' | 'react'
<RenderChildren items={[]} ctx="card" empty={<EmptyState/>} />
```

Для одиночного элемента — `<RenderItem value ctx />`.

**НИКОГДА в item views:**
- ❌ `<button onClick={navigate}>...</button>` — клик/навигация у наблюдателя
- ❌ `border`, `rounded-md`, `bg-card`, `px-3 py-2`, `hover:bg-accent/50` — chrome у наблюдателя
- ❌ `w-[200px]` — ширина у наблюдателя
- ❌ chevron `›`, decorative trailing affordances — у наблюдателя

**Дефолты:** `default`, `dir`, `ref` уже зарегистрированы для `react:list`/`react:card`/`react:icon` как content-only fallback. Регистрируй свой только если нужен специфический контент.

**Регистрация content-only items:**
- `view.list(Type, Item)`
- `view.card(Type, Item)` — пока через `view(Type, 'card', Item)` или `register(Type, 'react:card', Item)`
- `register(Type, 'react:icon', Item)`

**Что должно делать наблюдатель чтобы переключать вид:**
```tsx
const [ctx, setCtx] = useState<ChildCtx>('list');
return (
  <>
    <Switcher value={ctx} onChange={setCtx} />
    <RenderChildren items={children} ctx={ctx} />
  </>
);
```

См. [editor-ui/dir-view.tsx](mods/editor-ui/dir-view.tsx) — эталонный наблюдатель с переключателем.
