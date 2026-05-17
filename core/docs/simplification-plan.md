# Core Simplification Plan

This is the working queue for slimming `@treenx/core` after the stabilization
patches that accumulated over the last months.

No broad rewrite. Each item should become a small, test-backed change with a
clear before/after contract.

## Current Signals

- Runtime source in `engine/core/src` is about 11.5k lines; tests are about 19k
  lines.
- Largest runtime files: `schema/extract-schemas-oxc.ts`,
  `server/actions.ts`, `server/auth.ts`, `server/trpc.ts`, `mod/loader.ts`.
- `src/comp/CLAUDE.md` mentions `ports.ts` and `planner.ts`, but those files no
  longer exist. Local docs have drifted from code.
- Main remaining compatibility naming surface is `createNode` vs `makeNode`;
  keep it as a separate decision because current usage is broad.
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
   actions, validates args, enforces kind, persists Immer patches, and
   registers builtin patch. Split without changing the public execute API.

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

7. Extend MCP discovery across internal components.
   Let a target object expose MCP tools from its own type and from named
   components attached to the same node, so `/sys/mcp/tools` can compose
   `mcp.treenix`, `uix.mcp`, and future tool sets.

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

## Why Does Core Have `src/mods`?

Current inventory:

- `autostart`: server-side service starter built on the service context.
- `treenix`: built-in platform types such as users, groups, logs, prefabs,
  mods, system, and agent port.

These are not the same kind of thing. The folder currently mixes:

- built-in platform schema/type definitions;
- server boot services;
- optional feature modules.

Working rule:

- Core may keep mandatory platform definitions that are required for the server
  to function as Treenix.
- Optional features should live as normal mods/packages.
- Autostart is infrastructure. It can stay temporarily, but it should be named
  and loaded as server infrastructure, not presented as a generic core mod.

Revisit `autostart` and `treenix` separately.

## Remaining Legacy Decisions

1. `createNode` alias for `makeNode`.
   - Current code marks `createNode` deprecated, but repo usage is broad across
     core tests, mods, and packages.
   - Keep as-is for now: `create` reads as a finished action, while `make` reads
     as in-memory construction. Revisit as a separate naming task.
