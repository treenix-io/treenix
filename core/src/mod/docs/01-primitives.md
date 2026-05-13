# 01 — Three primitives

```
Node      = { $path, $type, ...components }   // entity in the tree
Component = { $type, ...data }                 // named aspect of a node
Context   = register(type, context, handler)   // type behavior in a context
```

A node is `$path` + `$type` + arbitrary components. A component is a named field with `$type`. A context binds behavior (render, action, service) to a type.

System fields: `$path`, `$type`, `$rev` (OCC), `$owner`, `$acl`.

## Mod structure

```
src/mods/my-mod/
  types.ts      — registerType() — component classes, data + actions
  action.ts     — register(type, 'action:name', handler) — node-level actions
  schemas.ts    — register(type, 'schema', () => ({...})) — JSON Schema for UI
  view.tsx      — register(type, 'react', Component) — React renderers
  service.ts    — register(type, 'service', handler) — background service
```

Registration:
- Server: add import to `src/mods/index.ts`
- Frontend: add import to `src/mods/views.ts` + `registerViews()`

## Dev workflow

```bash
npm run schema        # extract JSON Schema (auto on dev startup, manual for CI)
npm test              # tsx --test src/**/*.test.ts
npm run dev:server    # tsx --watch src/server/index.ts (port 3001)
npm run dev:front     # vite (React frontend)
```

Seed data: `data/base/` (git-tracked), runtime data: `data/work/` (gitignored).
Overlay: work on top of base — writes go to work, reads fall back to base.
