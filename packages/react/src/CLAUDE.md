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
