## Treenity

Low-code RAD platform. Tree of typed components with context-aware rendering.
Inspired by Unity3D ECS, Plan9 filesystem, Unix pipes.

# RULES

## Code
- DRY: if logic exists somewhere in the codebase, find and reuse it.
- KISS: simplest working solution. No premature abstractions, no over-engineering.
- Prefer small focused files — large files are hard to edit and reason about.
- Use blank lines to separate logical blocks within functions.
- Always use ES `import`. Never use `require()`.
- **`#` imports for package-internal paths.** Inside packages use `#core`, `#tree/cache`, `#components/ui/button` — NOT `@/`. This is Node.js native `imports` field (package.json), works in tsx, Node, Vite, everywhere. Each package maps `"#*"` → `"./src/*"`. Cross-package imports use full package name: `@treenity/core/tree`, `@treenity/react/hooks`.
- Fix imports at source. Never create re-export wrappers.
- Minimal comments — only for genuinely ambiguous logic. Minimal logging.

## Testing
- **Tests verify contracts, not implementation details.** Assert WHAT the system does (throws, returns shape), never HOW (error wording, internal path).
- Assert error **codes/types**, never message strings.
- Use `assert.rejects(fn, predicate)`, not `try/catch + assert.fail`.
- No `setTimeout` waits in tests — wait for actual events.
- Every `it()` must have at least one assertion.
- Restore any global state you mutate in `afterEach`.
- Bug fix → regression test covering the exact broken scenario.

## Errors
- Never use fallback values to mask failures. `x = response?.data?.value || []` is WRONG — validate and throw.
- Never silently skip errors in try blocks. FORBIDDEN!
- Only catch exceptions you can meaningfully handle. Always log the error.
- Never silently return null, zero, or empty. Propagate errors.

## Styling
- **Tailwind CSS v4** for all frontend styling. Never use inline `style={}`.
- Use `tailwind-merge` when combining conditional classes.

## Architecture Constraints
- **Core < 500 lines.** If more — something is wrong.
- **Zero dependencies** in core (only TypeScript).
- **No decorators.** Everything explicit.
- **No classes in core.** Plain objects + functions + TS types.
- **No Mobx, RxJS, Feathers in core.**
- **No persistence in core.** Storage adapters are separate packages.
- **No React in core.** React binding is a separate package.

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
- **`t.*` = treenity infrastructure** (`t.mount.fs`, `t.mount.overlay`, `t.mount.mongo`)
- **`{vendor}.*` = package types** (`acme.block.hero`, `acme.template`)

## Mutations — Actions, Not set()
- **NEVER use `tree.set()` from client code.** All client mutations go through **`execute(path, action, data)`**.
- Direct `set` is only valid for: admin tools, form editors, seed scripts, server-side actions.

## Tech
- TypeScript strict, ES2022, ESM
- tsx to run
- node:test for testing
- python3 for Python scripts
- react, dayjs, fetch (never axios)
