---
title: Project Structure
section: getting-started
order: 3
description: What lives where in a Treenix starter project
tags: [getting-started, beginner]
---

# Project Structure

A new project from `create-treenix` is a normal Node/Vite app with a Treenix tree behind it.

```
my-app/
├── tree/
│   ├── seed/          Seed tree checked into git
│   └── work/          Runtime writes, usually gitignored
├── mods/
│   └── example/       Example mod you can edit or delete
├── src/
│   └── main.tsx       Frontend entry, imports the Treenix React app
├── root.json          Server storage, ACL, and seed configuration
├── vite.config.ts     Vite + Treenix plugin
├── tsconfig.json      TypeScript config
└── package.json       Scripts and dependencies
```

## `mods/`

Mods are the application code you write. A small mod usually has:

```
mods/bookmarks/
  types.ts     Type classes and registerType()
  seed.ts      Initial nodes with registerPrefab()
  view.tsx     React views
  service.ts   Background service, optional
  schemas/     Generated JSON Schemas
```

The server loads convention files when it starts:

- `types.ts`
- `seed.ts`
- `service.ts`

The frontend loads convention files through the Vite plugin:

- `types.ts`
- `view.tsx`

If a mod has explicit `server.ts` or `client.ts` files, those entry files are loaded instead.

## `tree/seed/`

Seed data that belongs in the repo. It is read by the filesystem mount and normally not modified at runtime.

```
tree/seed/
  $.json             Root node
  example/
    $.json           /example node
```

Use this layer for content or defaults you want reviewed in pull requests.

## `tree/work/`

Runtime writes. In the default overlay, Treenix reads `tree/work/` first and falls back to `tree/seed/`.

If you edit seed data and do not see the change, a runtime node in `tree/work/` may be shadowing it. Delete `tree/work/` only when you are intentionally resetting local runtime state.

```bash
rm -rf tree/work
npm run dev
```

## `root.json`

`root.json` declares the root node, root ACL, seed filter, and storage topology.

Typical local shape:

```json
{
  "$path": "/",
  "$type": "metatron.config",
  "seeds": ["core", "example"],
  "mount": { "$type": "t.mount.overlay", "layers": ["base", "work"] },
  "base": { "$type": "t.mount.fs", "root": "tree/seed" },
  "work": { "$type": "t.mount.fs", "root": "tree/work" }
}
```

When you run `npx -y create-treenix mod create bookmarks -y`, the CLI adds `bookmarks` to `seeds` if that array exists.

## Imports

Use package imports in mods:

```typescript
import { createNode } from '@treenx/core'
import { registerType } from '@treenx/core/comp'
import { usePath, view } from '@treenx/react'
```

Avoid `require()` and private source aliases in application mods.

## Scripts

The starter command you use most:

```bash
npm run dev
```

That starts Vite on `3210` and the Treenix server on `3211`. Schemas regenerate on server startup and are written to `schemas/` directories next to the Type source files.

## Related

- [Quickstart & Setup](installation.md) — setup from scratch.
- [Tutorial](tutorial.md) — build your first mod.
- [Create a Mod](../guides/create-a-mod.md) — full mod lifecycle.
