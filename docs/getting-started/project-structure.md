---
title: Project Structure
section: getting-started
order: 3
description: What lives where in a Treenix starter project
tags: [getting-started, beginner]
---

# Project Structure

A new project from `create-treenix` is a Node/Vite app with a Treenix tree behind it.

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

You compose your app in the tree/work directory, which could be put anywhere to db, or fs.

## `mods/`

Mods are the pieces, we compose our applications from.  
application code you write. A small mod usually has:

```
mods/bookmarks/
  types.ts     Type classes and registerType()
  react.tsx     React views
```

```
  # additionals
  seed.ts      Initial nodes and prefabs
  service.ts   Background services, optional
  schemas/     Auto-generated JSON Schemas
```

The server loads convention files when it starts:

- `types.ts`
- `seed.ts`
- `service.ts`

The react frontend loads convention files through the Vite plugin:

- `types.ts`
- `react.tsx`

If a mod has explicit `server.ts` or `client.ts` files, those entry files are loaded instead.

## `tree/seed/`

Seed data that belongs in the repo. It is read-only tree layer, containing system brahches.
It is read by the filesystem mount and normally not modified at runtime.

```
tree/seed/
  $.json             Root node
  example/
    $.json           /example node
```

## `tree/work/`

Runtime writes above the seed tree. In the default overlay, Treenix reads `tree/work/` first and falls back to `tree/seed/`.

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
  "$type": "treenix.root",
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

Avoid private source aliases in application mods.

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
