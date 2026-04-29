---
title: Tutorial
section: getting-started
order: 2
description: Build a bookmark manager with a Type, seed data, actions, and React views
tags: [getting-started, beginner, tutorial]
---

# Tutorial: Build a Bookmark Manager

This tutorial starts from a working Treenix project and adds a small bookmark manager.

You will create:

- a `bookmarks.bookmark` Type;
- three actions: `archive`, `restore`, and `setTags`;
- seed nodes under `/bookmarks`;
- a detail view and a list view.

## Prerequisites

Finish [Quickstart & Setup](installation.md) first. You should be inside a project created by `create-treenix`.

## 1. Scaffold the Mod

From the project root:

```bash
npx -y create-treenix mod create bookmarks -y
```

The command creates `mods/bookmarks/`. If your `root.json` uses a `seeds` array, the CLI also adds `bookmarks` so its seed prefab deploys on startup. In the next steps you will replace the generated files with the bookmark implementation.

## 2. Define the Type

Replace `mods/bookmarks/types.ts`:

```typescript
import { registerType } from '@treenx/core/comp'

export class Bookmark {
  /** @title URL @format uri */
  url = ''

  /** @title Title */
  title = ''

  /** @title Tags @format tags */
  tags: string[] = []

  /** @title Archived */
  archived = false

  /** @description Archive this bookmark */
  archive() {
    this.archived = true
  }

  /** @description Restore this bookmark */
  restore() {
    this.archived = false
  }

  /** @description Replace all tags */
  setTags(data: { tags: string[] }) {
    this.tags = data.tags
  }
}

registerType('bookmarks.bookmark', Bookmark)
```

Fields become the schema. Prototype methods become actions. JSDoc feeds the Inspector and MCP descriptions.

## 3. Seed Data

Replace `mods/bookmarks/seed.ts`:

```typescript
import type { NodeData } from '@treenx/core'
import { registerPrefab } from '@treenx/core/mod'

registerPrefab('bookmarks', 'seed', [
  { $path: 'bookmarks', $type: 'dir' },
  {
    $path: 'bookmarks/treenix',
    $type: 'bookmarks.bookmark',
    url: 'https://github.com/treenix-io/treenix',
    title: 'Treenix on GitHub',
    tags: ['dev', 'framework'],
  },
  {
    $path: 'bookmarks/typescript',
    $type: 'bookmarks.bookmark',
    url: 'https://www.typescriptlang.org/docs/',
    title: 'TypeScript Handbook',
    tags: ['dev', 'docs'],
  },
] as NodeData[])
```

Seed prefabs named `seed` deploy on startup. If your `root.json` has a `seeds` array, make sure it includes `bookmarks`.

## 4. Add Views

Replace `mods/bookmarks/view.tsx`:

```tsx
import { useActions, useNavigate, view } from '@treenx/react'
import { Bookmark } from './types'

view(Bookmark, ({ value }) => {
  const actions = useActions(value)

  return (
    <article className="space-y-3 rounded border p-4">
      <div>
        <a
          href={value.url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-blue-600 hover:underline"
        >
          {value.title || value.url}
        </a>
        {value.archived && (
          <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs">
            archived
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {value.tags.map(tag => (
          <span key={tag} className="rounded bg-muted px-2 py-0.5 text-xs">
            {tag}
          </span>
        ))}
      </div>

      {value.archived ? (
        <button className="text-sm text-green-700" onClick={() => actions.restore()}>
          Restore
        </button>
      ) : (
        <button className="text-sm text-red-700" onClick={() => actions.archive()}>
          Archive
        </button>
      )}
    </article>
  )
})

view.list(Bookmark, ({ value, ctx }) => {
  const navigate = useNavigate()

  return (
    <button
      className="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left hover:bg-muted"
      onClick={() => navigate(ctx.node.$path)}
    >
      <span className={value.archived ? 'line-through text-muted-foreground' : ''}>
        {value.title || value.url}
      </span>
      {value.tags.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {value.tags.join(', ')}
        </span>
      )}
    </button>
  )
})
```

The default view renders a bookmark page. The list view renders each bookmark when its parent directory is shown.

## 5. Restart and Open It

Restart the dev server so the server loads the new Type and seed. Stop the existing `npm run dev` process if it is already running, then start it again:

```bash
npm run dev
```

Open [http://localhost:3210/t/bookmarks/treenix](http://localhost:3210/t/bookmarks/treenix).

Expected result:

- the bookmark renders with your custom view;
- clicking **Archive** changes the `archived` field;
- opening [http://localhost:3210/t/bookmarks](http://localhost:3210/t/bookmarks) shows the compact list view;
- `mods/bookmarks/schemas/bookmarks.bookmark.json` exists after server startup.

## 6. What You Built

```
mods/bookmarks/
  types.ts   Type class with fields and actions
  seed.ts    Initial nodes under /bookmarks
  view.tsx   Detail and list React views
  schemas/   Generated JSON Schema after startup
```

The bookmark Type now drives storage validation, Inspector fields, action execution, React rendering, realtime updates, and MCP descriptions.

## Next

- [Project Structure](./project-structure.md) — understand the starter layout.
- [Create a Mod](../guides/create-a-mod.md) — add services, tests, and packaging.
- [React Views](../guides/react-views.md) — learn the render contexts and hooks.
- [Actions](../concepts/actions.md) — async actions, streaming actions, and `getCtx()`.
