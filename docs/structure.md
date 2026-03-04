# Project Structure

Monorepo with npm workspaces. Three workspace roots: `core/`, `packages/*`, `mods/*`.

```
core/                     — @treenity/core (npm workspace)
  src/
    core/                 — L0: Node, Component, Context, Ref, Registry (<500 lines)
    comp/                 — L2: registerComp/registerType, action discovery, needs
    tree/                 — L1: Tree interface, cache, query
    store/                — L1: Store interface + adapters (memory, fs, mongo)
    schema/               — JSON Schema generation from registered types
    contexts/             — L2-3: context handlers (service, text, telegram)
    client/               — Client SDK (transport-agnostic TreenityClient)
    server/               — L4-5: HTTP server, tRPC, auth, mounts, MCP, subscriptions
    mod/                  — Module system (discovery, prefabs, dependency sort)
    mods/                 — Core infrastructure mods (treenity, uix)

packages/                 — Additional npm workspaces
  react/                  — @treenity/react (frontend: hooks, views, Vite dev server)
  create-treenity/        — CLI scaffolding tool
  agent-client/           — Headless agent client
  recall/                 — Memory/recall utilities

mods/                     — Application modules (each is an npm workspace)
  todo/                   — Example todo app
  cafe/                   — Cafe ordering system
  brahman/                — AI assistant
  agent/                  — AI agent framework
  landing/                — Landing page
  ...                     — Domain-specific modules

docs/                     — Public documentation
data/                     — FS store data (gitignored)
scripts/                  — Dev/ops scripts
```

## Where to put new code

| What               | Where                               |
| ------------------ | ----------------------------------- |
| New primitive/type  | `core/src/core/`                   |
| Storage adapter     | `core/src/store/`                  |
| Component system    | `core/src/comp/`                   |
| Rendering context   | `core/src/contexts/{binding}/`     |
| Server feature      | `core/src/server/`                 |
| Mount adapter       | `core/src/server/mount-adapters.ts`|
| Application module  | `mods/{name}/`                     |
| React components    | `packages/react/src/`              |
| Tests               | Co-located `{file}.test.ts`        |
