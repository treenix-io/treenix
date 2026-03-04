# Architecture Decisions

## D01: Components are named fields, not arrays

Proto1 used `_m[]` array of metas. Problem: "take first of type" — implicit convention,
different code took different ones. Named fields = explicit, no ambiguity.
Two components of same type allowed: `budget` and `estimate` both `$type: "money"`.

## D02: $type on node level = main type

Node has `$type` that determines what it IS (task, page, comment).
Additional components are extensions. Renderer looks at `$type` first.
No guessing "what should I render" — always determined.

## D03: Refs to nodes; intra-node via URI fragment (updated by D17)

**Original rule:** `{ $ref: "/tasks/456" }` — never `/tasks/456.budget`.
Proto1 had `tree:settings/scheduler$cron#minute` — three separators, regex, edge cases. Never again.

**Evolution (D17):** `{ $ref: "/path#field" }` — standard URL fragment for intra-node addressing.
Key difference from Proto1: one separator (`#`), standard URL syntax, core path untouched.
Path addresses node (L0). Fragment resolves within node (L2+). Clean layer boundary.

## D04: Children by path query, not stored in parent

`/projects/alpha/task-1` is child of `/projects/alpha` by path prefix.
Parent doesn't store children array. Scales to any number. Index on $path.

## D05: Context = exact string, colon-separated, deterministic fallback

`"react:compact:mini"` → try exact → try `default` at same context → strip suffix → recurse → null.
At each context level, `default` is checked before stripping. This means a `default@react:compact`
handler beats a type-specific `foo@react` handler — by design, more specific context wins.
Proto1 had space-separated tags with set intersection — non-deterministic which component selected.
Three levels maximum. No fuzzy matching. If registered — found. If not — null.

## D06: $ prefix for system, \_ in Mongo

`$path`, `$type`, `$ref` — system fields in memory/API.
Mongo can't store $ prefix (operator conflict). Transparent `$` ↔ `_` in toStorage/fromStorage.
`_id` from Mongo is skipped during fromStorage (not converted to `$id`).

## D07: No persistence in core

Core is pure data structures + functions. Storage adapters (Mongo, FS, Memory) are separate packages.
Core never imports mongodb, mongoose, fs. This keeps it testable and portable.

## D08: No React in core

React binding (`<Render value={data} />`, context providers) is a separate package.
Core `render()` returns `unknown` — the binding package wraps it for React.

## D09: Components don't access siblings directly

Component knows only its own data. If it needs neighbor data — declares `needs: { task: "task" }`,
system injects from above. No `node.get(OtherType)` from inside component.
Proto1-3 had components calling `node.get()` freely — created hidden dependency graphs.

## D10: Layer model is strict

Layer N never imports from Layer N+1. Core (L0) doesn't know about Mongo (L1),
React (L2), Queries (L3), Mounts (L4), tRPC (L5), LLM (L6).
Proto3 (MVP2) had 15 packages with circular deps between layers. Never again.

## D11: No decorators, no classes in core

Decorators hide logic, require reflect-metadata, complicate debugging.
Classes create inheritance temptation. Plain objects + functions + TS types.
Proto2 used `@type`, `@query`, `@mutation`, `@writeMethod` — magic that broke tooling.

## D12: Core < 500 lines

If core grows past 500 — something belongs in a higher layer.
Current: 194 lines. Headroom for minor additions, but the constraint is real.

## D13: Cascade fallback — instance → schema → null

One pattern everywhere. Component instance data → schema default → null.
No special cases, no "if type has X use Y else Z".

## D14: Children = ordered collections, Components = node aspects

Children (blocks, steps, items) are child nodes under a path — ordered, queryable, paginated.
Components (metadata, status, config) are named fields on the node — unordered aspects.
Never store ordered collections as components. Never model aspects as children.

## D16: Action mutation model — in-place via reference, not reducers

**Chosen:** class methods mutate `this` (which is `ctx.comp`, a reference into the node object).
After action returns, `store.set(node)` persists the whole node.

```
proto[name].call(ctx.comp, data, siblings)  // mutates in-place
await store.set(node)                        // persists after
```

**Alternative considered (Gemini review):** pure reducers returning patches:
```
publish(ctx) { return { value: 'published' } }  // returns diff
```
tRPC merges patch into node, then `store.set()`.

**Why in-place wins now:**
- Simpler: 1 line action vs patch + merge machinery
- No Proxy, no diffing, no magic — plain JS object reference semantics
- Predictable: action mutates component, `store.set` after

**Known tradeoffs:**
- If action throws, node object in memory is already mutated (but next request fetches fresh from store — no real corruption)
- No free diff — event sourcing / undo would need snapshot-before + snapshot-after
- Action author doesn't see the `store.set` — it's implicit in the execute flow

**When to reconsider:** if event sourcing or undo/redo becomes a real requirement, switch to reducer model. The change is localized to `registerComp` + `trpc.execute` (~20 lines).

## D15: Reactive subscriptions — watch/unwatch on paths

Layer 5 (tRPC). Core and store don't know about subscriptions.

**Model:** `Map<path, Set<clientId>>` on server, refcount on client.

**API:** flag on existing methods + one new method:

- `get(path, { watch: true })` → node + subscription, atomic (no race between get and watch)
- `children(path, { watch: true, limit? })` → nodes + subscription to each returned node (not parent)
- `unwatch(paths[])` → unsubscribe

**Client cache:** `Map<path, Node>`. Second request for same path → from cache, no roundtrip.

**On mutation:** `watchers.get(path)` → O(1) exact lookup, not filter evaluation (vs Meteor/Supabase O(changes×subscriptions)).

**Push:** whole node. No field-level diff, no merge box. Delete → `{ path, deleted: true }`.

**New children:** not tracked. Client re-queries manually. watchNew — deferred.

**ACL:** checked once on get/children. Push without re-check (client already authorized). ACL on push — deferred.

**Disconnect:** full cleanup of all client subscriptions.

## D17: Treenity URI — universal intra-node addressing

**Format:** `/path[?query]#[key.]name[()]` — standard URL order (path → query → fragment).

Parsed via native `URL` — free encoding, edge case handling.

**Grammar:**
```
/path#field                  → read field on $type component
/path#key.field              → read field on named component
/path#action()               → execute action (scan $type)
/path#key.action()           → execute action on named component
/path?x=1&y=2#action()      → execute with parameters
```

**Key design choices:**

1. `()` distinguishes call from read — universally understood (JS, Python, every language).
   Alternatives considered: `!` (shebang conflict `#!`, ugly `!?`), `$` (conflicts with system fields),
   `:` (conflicts with contexts). `()` wins: no conflicts, valid in URI fragments (RFC 3986).

2. `.` separates key from name — same as JS property access (`obj.field`, `obj.method()`).

3. `?` carries parameters — standard URL query string with dot-notation for nesting
   (`age.$gt=10` → `{ age: { $gt: 10 } }`).

4. The URI is **just an address** — it doesn't carry the verb. But the syntax makes the intent
   visible: `#field` = data, `#action()` = call. You can tell by looking.

5. `$ref` field-level: `{ $ref: '/path#field' }` resolves to a value.
   `action` field: `'/path#action()'` triggers execution.
   Same addressing, different usage context. Like HTTP: same URL, GET vs POST.

**What this replaces:** ad-hoc action wiring, string-based field references.

**Where it lives:** utility at L2+ (`parseURI`). Core (L0) doesn't know about URIs.
Path system unchanged — paths address nodes, fragments address within.

## D18: Action signature duality — parameters in code, ports in graph

Action method `data` type serves two purposes from a single TypeScript signature:

```ts
async charge(data: { amount: number, account: Account, user?: User })
```

**In code:** plain typed call — `invoice.charge({ amount: 10, account: user.account })`.
Caller passes values, TypeScript checks types at compile time.

**In visual editor:** component types in the signature become **ports** (connectable sockets).
`account: Account` = required input port. `user?: User` = optional port. `amount: number` = value field.
Graph compiler collects values from wired connections into the `data` object.

**Why this works:**
- No separate DSL for port declarations — the type IS the declaration
- JSON Schema generated automatically — AI/UI introspection for free
- Component classes are ES exports — mods import each other's types directly, no plugin API
- `?` = optional port, required = mandatory port — TypeScript syntax maps naturally

**What this replaces:** separate port metadata, DI frameworks, event bus wiring.
