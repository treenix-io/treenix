---
title: Examples
section: examples
order: 0
description: Live mod demos — read the code, run the thing
tags: [examples, mods]
---

# Examples

Each of these is a real [mod](../guides/create-a-mod.md) that ships with the engine. Read the source to see patterns in full; run the demo to see the same code alive.

## Starter playground (`mods/example`)

The default `example/` mod in the [starter](../getting-started/installation.md). A mixed bag — the shortest possible demonstration of every primitive.

| Node | What it shows |
|---|---|
| `example/counter` | Simplest possible [Type](../concepts/types.md) + [actions](../concepts/types.md#rpc) |
| `example/todos` | A list with [children](../concepts/composition.md#node), `useChildren` with `watchNew` |
| `example/poll` | State-machine [Validation](../concepts/security.md#validation) |
| `example/ticker` | A [service](../concepts/context.md#services) producing live children |

**Start here** if you're new.

```bash
npx -y create-treenix my-app
cd my-app && npm run dev
# open http://localhost:3210/t/example/counter
```

## Engine mods

Shipped under `engine/mods/*`. Each has its own `CLAUDE.md` summarizing types / actions / views.

| Mod | What it shows | Difficulty |
|---|---|---|
| `engine/mods/doc` | [Tiptap](https://tiptap.dev) editor + FS codec (`.md` ↔ `doc.page` nodes) | ★★★☆ |
| `engine/mods/tasks` | Task management — a reasonable real-world mod | ★★☆☆ |
| `engine/mods/board` | Kanban board — multiple Views per Type, drag-and-drop | ★★★☆ |
| `engine/mods/simple-components` | Many tiny Types, each demonstrating one capability | ★☆☆☆ |
| `engine/mods/brahman` | Telegram bot builder with visual flow | ★★★★ |
| `engine/mods/metatron` | AI agent workspace | ★★★★ |
| `engine/mods/three` | 3D scene rendered with react-three-fiber (lazy-loaded) | ★★★★ |
| `engine/mods/mcp` | How a mod exposes itself to [agents](../concepts/ai-mcp.md) | ★★★☆ |

## Reading order

If you're learning the framework, read in this order — each builds on the previous:

1. **`engine/mods/simple-components`** — atomic demos per primitive.
2. **`engine/mods/tasks`** — typical CRUD with Views.
3. **`engine/mods/doc`** — codec-driven persistence, non-trivial editor integration.
4. **`engine/mods/board`** — multiple contexts on one Type.
5. **`engine/mods/brahman`** — full vertical — types, views, services, visual flow.

## Related

- [Tutorial](../getting-started/tutorial.md) — build the bookmark manager from scratch
- [Build a Mod](../guides/create-a-mod.md) — patterns, structure, testing
- [Cookbook](../resources/cookbook.md) — snippet-sized recipes
