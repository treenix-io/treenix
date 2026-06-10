## Treenix

Low-code RAD platform. Tree of typed components with context-aware rendering.
Inspired by Unity3D component model, Plan9 filesystem, Unix pipes.

HI!

# RULES

## Code
- DRY: if logic exists somewhere in the codebase, find and reuse it.
- Prefer small focused files — large files are hard to edit and reason about.
- Use blank lines to separate logical blocks within functions.
- Always use ES `import`. Never use `require()`.
- **`#` imports for package-internal paths.** Inside packages use `#core`, `#tree/cache`, `#components/ui/button` — NOT `@/`. This is Node.js native `imports` field (package.json), works in tsx, Node, Vite, everywhere. Each package maps `"#*"` → `"./src/*"`. Cross-package imports use full package name: `@treenx/core/tree`, `@treenx/react/hooks`.
- Fix imports at source. Never create re-export wrappers.
- Minimal comments — only for genuinely ambiguous logic. Minimal logging.

## Type hygiene
- **No `as` for widening / placeholders / muting tsc.** If you write `value as T` to "shut up" the compiler, you're hiding a real signal. Fix the source type, narrow via a type predicate (`function isX(v): v is X`), or accept a wider input parameter. The ONLY legitimate casts are: `as const`, narrowing to a literal (`as 'idle'`), and decoding at a system boundary (JSON parse, wire-format deserialize) where the type system genuinely can't help.
- **Never `{} as SomeType` / `[] as T[]` / `null as X`.** If every field is optional, the literal `{}` is structurally valid without a cast — let TS resolve it via the param/return type. If a generic placeholder is forced, use a type guard or accept the cost (`Object.create(null) as T` for true unknown shapes ONLY).
- **No `as unknown as X` double-casts** unless the values truly come from outside (web API, JSON.parse, wire format). Inside our own code, the right answer is a guard or a corrected source type.
- **Type predicates do narrow.** If `isRef(node)` is `(v): v is Ref`, then after `if (!isRef(node)) return;` the variable IS `Ref` — no `as Ref` needed. Casting after a guard means the guard isn't a real predicate; fix the predicate.
- **No inline anonymous types if they repeat.** If `Foo & { bar?: Baz }` appears twice, name it once. Inline shapes accumulate; named types document intent and break duplication.
- **API abuse smells like a cast.** Passing `{} as Base` to a function that "needs a base to merge into" usually means the function signature is wrong — accept `Partial`, default the parameter, or split the no-base path into its own helper.

## Comments
- **Default: no comment.** Code with well-named identifiers + small functions explains itself.
- **A comment must answer WHY, not WHAT.** "this iterates the array" — useless. "ordering matters here because consumer X must populate buffer Y first" — load-bearing.
- **WHAT-comments to delete on sight:**
  - "Wrap each listener so one buggy consumer can't break the loop" (the try/catch shows it)
  - "Apply transformation Z" right above the line that applies transformation Z
  - JSDoc that paraphrases a self-documenting parameter (`{path: string} // the path to use`)
  - Type-system narration ("X is assignable to Y so we don't need a cast")
  - Multi-paragraph headers explaining a module's purpose when the filename + exports already say it
  - "Order: rmVps → put → addVps" right before code that literally does rmVps, put, addVps in that order — UNLESS there's a hidden invariant ("unlinking first prevents the put's fan-out from firing a vp about to be removed")
- **KEEP comments that capture hidden invariants:** historical-bug fixes (`R4-X`/incident refs), non-obvious ordering constraints, surprising-but-correct behavior, security-fail-closed branches, TODO with a real follow-up condition.
- **Rule of thumb:** if you delete the comment and a careful reader can still understand the code in 30 seconds, delete it. If the reader would reach the wrong conclusion, the comment was load-bearing — keep it (or tighter, sharper).
- **Existing comments stay UNLESS they became factually wrong.** Don't keep a lie; either update or delete.

## Testing
- **Tests verify contracts, not implementation details.** Assert WHAT the system does (throws, returns shape), never HOW (error wording, internal path).
- Assert error **codes/types**, never message strings.
- Use `assert.rejects(fn, predicate)`, not `try/catch + assert.fail`.
- No `setTimeout` waits in tests — wait for actual events.
- Every `it()` must have at least one assertion.
- Restore any global state you mutate in `afterEach`.
- Bug fix → regression test covering the exact broken scenario.

## Errors
- **Always fix root causes, not symptoms.** If a bad value appears — find WHERE it enters the system and reject it there. Don't patch downstream code to tolerate garbage.
- Never use fallback values to mask failures. `x = response?.data?.value || []` is WRONG — validate and throw.
- Never silently skip errors in try blocks. FORBIDDEN!
- Only catch exceptions you can meaningfully handle. Always log the error.
- Never silently return null, zero, or empty. Propagate errors.

## Styling
- **Tailwind CSS v4** for all frontend styling. Never use inline `style={}`.
- Use `tailwind-merge` when combining conditional classes.

## Architecture Constraints
"Core" below = Layer 0 (`core/src/core`) — the primitives. The @treenx/core PACKAGE is the
server platform around them (~12k LOC); its upper layers may use focused deps.
- **Layer 0 < 500 lines** (currently ~455). If more — something is wrong.
- **Layer 0 has zero imports** (only TypeScript). Upper layers: sift (tree), immer/quickjs (server), trpc (edge) — new deps need a reason at review.
- **No decorators.** Everything explicit.
- **No classes in Layer 0.** Plain objects + functions + TS types.
- **No Mobx, RxJS, Feathers** anywhere in the package.
- Persistence: memory/fs adapters live in `core/src/tree` (Layer 1, in-package); heavier backends (Mongo) are separate packages.
- **No React in @treenx/core.** React binding is a separate package.

## Layer Model (lower layers NEVER know about upper)
- **Layer 0**: Node + Component + Context + Ref (core)
- **Layer 1**: Storage adapters (Mongo/FS/Memory)
- **Layer 2**: React binding, Telegram binding
- **Layer 3**: Queries, children filtering
- **Layer 4**: Mounts, external API adapters
- **Layer 5**: tRPC/REST exposure
- **Layer 6**: LLM integration

## Three Primitives
```
Component = { $type: string } & Data
Node      = { $path, $type, ...components }
Context   = Map<type+context, handler>
```

## Type Naming Convention
- Separator: `.` only
- **No dot = core built-in** (`dir`, `ref`, `root`, `user`, `type`, `mount-point`, `autostart`)
- **`t.*` = treenix infrastructure** (`t.mount.fs`, `t.mount.overlay`, `t.mount.mongo`)
- **`{vendor}.*` = package types** (`acme.block.hero`, `acme.template`)

## Mutations — Actions, Not set()
- **NEVER use `tree.set()` from client code.** All client mutations go through **`execute(path, action, data)`**.
- Direct `set` is only valid for: admin tools, form editors, seed scripts, server-side actions.

## Views — useActions, not ctx.execute
- **Always use `useActions(value)`** in React views for calling actions. Never build custom `exec()` wrappers around `ctx.execute`.
- Pattern: `const actions = useActions(value); actions.add({ text });` — typed, with autocomplete.
- **Never `ctx.execute('action', data)`** — untyped string, no autocomplete, violates conventions.

## Node creation — use core helpers
- **Use `createNode(path, type, data)` from `@treenx/core`** to construct NodeData. Never build `{ $path, $type, ... }` objects manually — `createNode` validates system field names and normalizes types.

## Tech
- TypeScript strict, ES2022, ESM
- tsx to run
- node:test for testing
- **Always run tests via `npm test`**, not `npx tsx --test` directly — scripts pass `--conditions development` needed for `#*` imports to resolve to `src/` instead of `dist/`
- python3 for Python scripts
- react, dayjs, fetch (never axios)
