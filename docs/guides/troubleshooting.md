---
title: Troubleshooting
section: guides
order: 9
description: Common errors, what they mean, how to fix them
tags: [guide, debugging]
---

# Troubleshooting

Fifteen of the most common things that go wrong, what causes them, and the fix.

Each entry is **symptom → diagnosis → fix → related reading**. If the exact message doesn't match, match by shape — the underlying cause is usually one of these.

## 1. `TypeError: value.increment is not a function`

**Symptom.** A View calls `value.method()` and crashes.

**Diagnosis.** `value` in a View is plain typed data — not a proxy. Methods live on the [Type](../concepts/types.md) class; they don't exist on the data passed to renderers.

**Fix.** Use `useActions(value)` or `usePath(path, Class)`.

```tsx
// WRONG
<button onClick={() => value.toggle()} />

// RIGHT
const actions = useActions(value)
<button onClick={actions.toggle} />
```

See [Write React Views](./react-views.md) and [Type → RPC](../concepts/types.md#rpc).

## 2. View<any> or View<NodeData>

**Symptom.** TypeScript passes but IntelliSense is gone, fields are untyped, `as any` creeps in.

**Diagnosis.** Wrong generic parameter. `View<T>` should get the specific Type class.

**Fix.** Pass the Class.

```tsx
// WRONG
const TaskView: View<any> = ({ value }) => ...
const TaskView: View<NodeData> = ({ value }) => ...

// RIGHT
const TaskView: View<Task> = ({ value }) => ...
```

See [Contexts → Views](../concepts/context.md#views).

## 3. `register('my.type', 'react', View)` — nothing renders

**Symptom.** View is registered but `<Render>` falls through to the Inspector.

**Diagnosis.** String-based `register` is the legacy path. Current API takes the Class.

**Fix.**

```tsx
// WRONG
register('todo.task', 'react', TaskView)

// RIGHT
register(Task, 'react', TaskView)
```

See [Contexts](../concepts/context.md).

## 4. Action fails silently with no error

**Symptom.** `useActions(value).save()` returns without error but the node didn't change.

**Diagnosis.** The ACL on the target node denied the write. `fail-closed` rules reject quietly from the caller's perspective; the rejection shows up in the server logs.

**Fix.** Check the node's `$acl` against the caller's groups. Every action needs an explicit allow for write.

```typescript
$acl: [
  { g: 'editors', p: R | W | S },
  { g: 'public',  p: R },
]
```

See [Security → ACL](../concepts/security.md#acl).

## 5. `ValidationError` on a method call

**Symptom.** Calling an action throws `ValidationError: <field> must be ...`.

**Diagnosis.** The `data` argument doesn't match the method's declared parameters. [Validation](../concepts/security.md#validation) runs before the call reaches the method body.

**Fix.** Align the call with the method signature.

```typescript
/** @description Charge the invoice */
charge(data: { method: 'card' | 'wire' }) { /* ... */ }

// WRONG
actions.charge({ method: 'crypto' })   // rejected — enum violation

// RIGHT
actions.charge({ method: 'card' })
```

See [Type → Schema](../concepts/types.md#schema).

## 6. `usePath` returns undefined forever

**Symptom.** `const { data: task } = usePath(path, Task)` — `task` fields stay undefined.

**Diagnosis.** In typed mode, `usePath` returns `Query<TypeProxy<T>>`. During initial load, the proxy exists but field reads yield `undefined`. Check `loading` before using fields.

**Fix.**

```tsx
const { data: task, loading } = usePath(ctx!.node.$path, Task)
if (loading) return <Spinner />
return <div>{task.title}</div>
```

Method calls always queue — they work regardless of load state.

See [The Tree → Subscriptions](../concepts/tree.md#subscriptions).

## 7. `useChildren` returns an array-less object

**Symptom.** `tasks.map is not a function`.

**Diagnosis.** `useChildren` returns a `ChildrenQuery`, not an array. Destructure `data`.

**Fix.**

```tsx
// WRONG
const tasks = useChildren(path)
tasks.map(...)

// RIGHT
const { data: tasks, hasMore, loadMore } = useChildren(path)
tasks.map(...)
```

See [Go Realtime](./go-realtime.md).

## 8. Node re-renders constantly

**Symptom.** CPU burns, view flickers.

**Diagnosis.** Dummy `useState(0) + setTick` to force re-renders; the React Compiler optimizes unused state away. Or: an object literal in `useState()` / `useRef()` gets re-evaluated every render.

**Fix.** Store meaningful state used in render. Use lazy initializers.

```tsx
// WRONG
useRef(new ExpensiveThing())           // evaluated each render
useState({ count: 0 })                  // new object each call
const [tick, setTick] = useState(0)     // dummy counter

// RIGHT
useState(() => new ExpensiveThing())    // lazy initializer
const CONFIG = { count: 0 }             // module-level constant
// subscribe to the data you actually render
```

## 9. Watch doesn't trigger when I change the parent

**Symptom.** Subscribing to `/orders` misses updates to `/orders/123`.

**Diagnosis.** By default, low-level subscriptions watch the exact path. To include descendants, pass `{ children: true }`.

**Fix.**

```typescript
ctx.subscribe('/orders', handler, { children: true })
```

See [Reactivity](../concepts/reactivity.md).

## 10. Ref doesn't resolve

**Symptom.** A `{ $type: 'ref', $ref: '/somewhere' }` appears in data; code tries to use it as a Node.

**Diagnosis.** Refs are lazy pointers, not automatic derefs.

**Fix.** Check with `isRef()`, resolve explicitly.

```typescript
import { isRef } from '@treenx/core'

if (isRef(field)) {
  const target = await tree.get(field.$ref)
}
```

## 11. Mod imports work in dev but fail in production

**Symptom.** Everything runs locally but the production build misses types.

**Diagnosis.** Mods need both `server.ts` and `client.ts` entry points, and both need to import `./types` for `registerType` to run.

**Fix.**

```typescript
// mods/my-mod/server.ts
import './types'
import './seed'

// mods/my-mod/client.ts
import './types'
import './view'
```

See [Build a Mod](./create-a-mod.md).

## 12. Changes to `tree/seed/` don't appear

**Symptom.** Edited a seed JSON, restarted, the change isn't visible.

**Diagnosis.** The [overlay mount](../concepts/mounts.md) reads `tree/work/` first. A node previously edited at runtime lives in `tree/work/` and shadows the new `tree/seed/` version.

**Fix.**

```bash
# Drop runtime writes, re-seed from base
rm -rf tree/work
npm run dev
```

See [Mounts](../concepts/mounts.md).

## 13. The frontend tree is empty after a restart

**Symptom.** Data was there yesterday; today the UI is empty.

**Diagnosis.** The server used an in-memory mount that didn't persist, or the overlay's work layer was deleted.

**Fix.** Check `root.json`:

```json
{
  "mount": { "$type": "t.mount.overlay", "layers": ["base", "work"] },
  "base":  { "$type": "t.mount.fs", "root": "tree/seed" },
  "work":  { "$type": "t.mount.fs", "root": "tree/work" }
}
```

If the mount type is `t.mount.memory`, switch to `t.mount.fs` or `t.mount.mongo` for persistence.

## 14. A Component I attached gets stripped on read

**Symptom.** `getComponent(node, 'groups')` returns `undefined` when the data is right there in the JSON.

**Diagnosis.** Component-level ACL — the caller doesn't have read permission on that specific Component. The node is readable, but the Component is stripped.

**Fix.** Check the Component's registered ACL:

```typescript
register('groups', 'acl', () => [
  { g: 'admins', p: R | W | A | S },
])
```

Either add the caller's group or remove the component-level ACL if everyone should see it.

See [Security → Component-level ACL](../concepts/security.md#acl).

## 15. Inline `style={}` didn't render

**Symptom.** CSS works in a one-off component, not in a View.

**Diagnosis.** Project styling is Tailwind CSS v4; inline styles are not the supported path and can conflict with the design system.

**Fix.** Tailwind classes.

```tsx
// WRONG
<div style={{ display: 'flex', gap: 8 }}>

// RIGHT
<div className="flex gap-2">
```

For conditional classes, use `tailwind-merge`:

```tsx
import { cn } from '@treenx/react'
<div className={cn('px-3 py-2', active && 'bg-primary')} />
```

See [Write React Views → Styling](./react-views.md).

## Related

- [Write React Views](./react-views.md) — common-mistakes table lives there too
- [Type](../concepts/types.md) — schema, actions, validation
- [Security](../concepts/security.md) — ACL, Validation, fail-closed
- [Reactivity](../concepts/reactivity.md) — subscription semantics
- [Cookbook](../resources/cookbook.md) — working examples for the patterns above
