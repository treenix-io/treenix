# Loading Pipeline

How server and client load code in dev and production modes.

## Server

**Dev:**
```bash
tsx --conditions development --watch src/server/main.ts ../root.json
```

**Startup flow** (`core/src/server/main.ts`):
1. Load `.env`
2. Read `root.json` (bootstrap config: mounts, ACL, root node)
3. `loadAllMods('server')` — three stages:
   - Core mods (`core/src/mods/`) — hardcoded barrel `servers.ts`
   - Engine mods (`engine/mods/*/server.ts`) — directory scan
   - Project mods (`mods/*/server.ts`) — directory scan from CWD
4. Create bootstrap tree from `root.json`
5. `createTreenityServer(bootstrap)` — pipeline: mounts → volatile → validation → subscriptions
6. Seed data
7. Start services (MCP, autostart)
8. Listen on PORT (default 3211)

**Mod loading** (`core/src/mod/loader.ts`):
- Scans directory for subdirs containing `server.ts`
- `import(fullPath)` each file (dynamic import)
- `registerType()` calls inside types.ts make type visible in `/sys/types` via `createTypesStore`
- Without `server.ts` → type not in `/sys/types` → invisible in UI

## Client (Vite)

**Dev:**
```bash
vite dev  # port 3210, proxies /trpc/ → 3211
```

**Loading flow** (`packages/react/src/load-client.ts`):
```typescript
import.meta.glob('./mods/*/client.ts', { eager: true });  // internal react mods
import 'virtual:mod-clients';                               // external mods
```

**`virtual:mod-clients`** (`packages/react/vite-plugin-treenity.ts`):
- Vite plugin generates a virtual module with import statements
- Discovers mods from two sources:
  1. npm packages with `treenity.clients` field in package.json (e.g. `@treenity/core`)
  2. `mods/*/client.ts` files (directory scan)
- Result: all mod `client.ts` files imported at build time

## `#` Imports

Node.js native `imports` field in `package.json`:
```json
"imports": {
  "#*": { "development": "./src/*.ts", "default": "./dist/*.js" }
}
```

| Mode | Flag | Resolution |
|------|------|------------|
| Dev  | `--conditions development` | `#core` → `./src/core.ts` |
| Prod | (no flag) | `#core` → `./dist/core.js` |

- **Server (Node/tsx):** respects `--conditions` natively
- **Client (Vite):** custom plugin resolves `#*` by reading importer's `package.json` and matching conditions
- **Mods** use full package names (`@treenity/core/*`, `@treenity/react/*`), not `#` imports

## Mod File Convention

```
mods/{name}/
  types.ts    — registerType() — imported by BOTH server.ts and client.ts
  server.ts   — import './types'; import './seed';
  client.ts   — import './types'; import './view';
  view.tsx    — register(type, 'react', View)
  seed.ts    — export default async (store) => { ... }
```

## Summary

| | Dev | Production |
|---|---|---|
| **Server** | `tsx --conditions development --watch` | `tsx` (uses `dist/`) |
| **Client** | Vite dev server + HMR | Vite build → static bundle |
| **`#` imports** | `./src/*.ts` | `./dist/*.js` |
| **Mod discovery** | Filesystem scan at startup | Same |
| **Ports** | 3210 (frontend), 3211 (backend), 3212 (MCP) | Configurable |
