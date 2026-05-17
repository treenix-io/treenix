# Core Simplification Plan

This is the working queue for slimming `@treenx/core` after the stabilization
patches that accumulated over the last months.

No broad rewrite. Each item should become a small, test-backed change with a
clear before/after contract.

## Current Signals

- Runtime source in `engine/core/src` is about 11.5k lines; tests are about 19k
  lines.
- Largest runtime files: `schema/extract-schemas-oxc.ts`,
  `server/actions.ts`, `server/auth.ts`, `mods/uix/jsx-parser.ts`,
  `server/trpc.ts`, `mod/loader.ts`.
- `src/comp/CLAUDE.md` mentions `ports.ts` and `planner.ts`, but those files no
  longer exist. Local docs have drifted from code.
- Several APIs are explicit compatibility surfaces: `createNode`,
  `collectSiblings`, `createTreenixServer`, `applyTemplate` over tRPC.
- There are production `as any` uses and silent catches that need review. Some
  are external-boundary tolerant code; trusted-boundary cases should be removed
  or made loud.

## Queue

1. Map public contracts.
   Record package exports, treenix manifest entries, pipeline order, and known
   external callers before changing layout.

2. Re-check layer boundaries.
   `core` should stay primitive-only. `tree` should not know server. `comp`
   currently imports tracking, schema types, tree types, and logging; decide
   whether this remains the component bridge or gets split.

3. Split server actions.
   `server/actions.ts` currently resolves handlers, loads dynamic QuickJS
   actions, validates args, enforces kind, persists Immer patches, applies
   templates, and registers builtin patch. Split without changing the public
   execute API.

4. Audit server pipeline order.
   Current order: migration -> mounts -> volatile -> validation -> ref index ->
   cache -> subscriptions -> router. Verify cache/ref/sub ordering and the
   intended `mountable` bypass used by seed, logs, and autostart.

5. Tighten ACL, watches, and subscriptions.
   Define exactly where events are filtered, where confidentiality requires
   fail-closed drops, and where drops must still log loudly.

6. Split schema extractor.
   `schema/extract-schemas-oxc.ts` should become phases: JSDoc parsing, import
   resolution, TypeScript type to schema, class/action extraction, and writing.

7. Move UIX out of core.
   See the dedicated section below.

8. Inventory legacy APIs.
   For each compatibility surface, decide: keep, deprecate with tests, or remove
   after repository usage search.

9. Improve type hygiene.
   Start with production `as any` in `core/registry.ts`, `core/component.ts`,
   `chain.ts`, `tree-chain.ts`, `server/actions.ts`, `server/client.ts`, and
   `mods/treenix/agent-port.ts`. Fix source types rather than casting at use
   sites.

10. Establish baseline before code changes.
    Run `npm run typecheck` and `npm test -w @treenx/core` before each change
    group.

## Item 7: UIX And Core Mods

### Problem

`engine/core/src/mods/uix` imports `react` and `@treenx/react`:

- `mods/uix/compile.ts` imports React and React rendering helpers.
- `mods/uix/client.ts` imports React and `@treenx/react` cache/tree helpers.
- UIX tests import React and `react-dom/server`.

That makes `@treenx/core` carry a React-aware runtime module, even though core's
architecture says core must not depend on React. It also makes `src/mods` a mixed
bag: some entries are core platform types, some are server services, some are UI
client/runtime.

### Initial Decision

Move UIX runtime out of `@treenx/core`.

Preferred first target: `@treenx/react`, because current UIX compile scope is
React-specific and imports `@treenx/react` directly.

Possible later target: a separate `@treenx/uix` package if UIX should become
installable without the full React admin package, or if it grows a non-React
compiler/runtime.

### Proposed Split

- Move to `@treenx/react`:
  - `mods/uix/client.ts`
  - `mods/uix/compile.ts`
  - `mods/uix/jsx-parser.ts`
  - related UIX React tests
- Keep or move carefully:
  - `mods/uix/uix-source.ts` is mostly a type/schema registration. It can stay
    temporarily if existing data uses `uix.source`, but long term it belongs
    with the UIX package that owns the feature.
  - `mods/uix/schemas/uix.source.json` should move with `uix-source.ts` once
    schema loading paths are adjusted.
- Remove from core client barrel:
  - `core/src/mods/clients.ts` should stop importing UIX once `@treenx/react`
    owns it.

### Migration Shape

1. Search all imports and dynamic registrations for `#mods/uix`,
   `uix.source`, `compileComponent`, `compileJSX`, and `onResolveMiss('react')`.
2. Copy UIX runtime into `engine/packages/react/src/mods/uix`.
3. Wire `engine/packages/react/src/mods/clients.ts` to import the moved UIX
   client registration.
4. Decide whether `uix.source` type registration moves in the same patch or a
   follow-up patch. Prefer a follow-up if schema loading makes this risky.
5. Leave a temporary compatibility export only if repo usage requires it.
   Otherwise remove the core module directly and let typecheck show callers.
6. Run:
   - `npm test -w @treenx/core`
   - `npm test -w @treenx/react`
   - `npm run typecheck`

### MCP Follow-Up

`compile_view` belongs to UIX, not to `mcp.treenix`. Move it behind a separate
UIX-owned MCP object (`uix.mcp`) first. Later, extend MCP discovery so a target
object can expose actions from its inner components as additional MCP tools.
That would let `/sys/mcp/tools` stay the single target while composing
tree/catalog tools with UIX tools and other component-owned tool sets.

### Why Not Separate Package First

Separate package is cleaner long term, but first moving into `@treenx/react`
removes the architectural violation with less package/export churn. UIX already
depends on React binding internals, so the minimal correct home is the React
package.

## Why Does Core Have `src/mods`?

Current inventory:

- `autostart`: server-side service starter built on the service context.
- `treenix`: built-in platform types such as users, groups, logs, prefabs,
  mods, system, and agent port.
- `uix`: React-specific dynamic view compiler/runtime.

These are not the same kind of thing. The folder currently mixes:

- built-in platform schema/type definitions;
- server boot services;
- optional feature modules;
- React client runtime.

Working rule:

- Core may keep mandatory platform definitions that are required for the server
  to function as Treenix.
- Optional features should live as normal mods/packages.
- React runtime belongs in `@treenx/react`.
- The former core `llm` mod was removed; future LLM-facing surfaces should be
  optional mods/packages, not core defaults.
- Autostart is infrastructure. It can stay temporarily, but it should be named
  and loaded as server infrastructure, not presented as a generic core mod.

After UIX moves, revisit `autostart` and `treenix` separately.
