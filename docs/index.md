---
title: Introduction
section: root
order: 0
description: Build typed apps on a live tree of nodes, actions, views, and services
tags: [intro, overview]
---

# Introduction

Treenix is a TypeScript platform for apps whose data is addressable, typed, reactive, and available to both humans and agents.

You define a Type as a class. Treenix uses it to validate stored data, render Inspector forms, expose actions, stream updates, and describe tools to MCP clients.

```typescript
import { registerType } from '@treenx/core/comp'

export class TodoItem {
  title = ''
  done = false

  /** @description Toggle done status */
  toggle() {
    this.done = !this.done
  }
}

registerType('todo.item', TodoItem)
```

Create a node with `$type: 'todo.item'`, and the method is now callable from the UI, React views, server code, and MCP through the same write pipeline.

## What You Build With

- **Nodes** are addressable data: `/todos/buy-milk`.
- **Types** define the data shape and actions.
- **Views** render the same node in different contexts, such as detail, list, or editor.
- **Services** run background work tied to nodes.
- **Mounts** let different subtrees use different storage backends.

## Start Here

1. [Quickstart & Setup](./getting-started/installation.md) — create a project, run it, and make the first change.
2. [Tutorial](./getting-started/tutorial.md) — build a bookmark manager.
3. [Project Structure](./getting-started/project-structure.md) — learn what the starter created.
4. [Thinking in Treenix](./getting-started/thinking-in-treenix.md) — learn the modelling style.

## When Treenix Fits

Use Treenix when the same domain object needs to be edited, rendered, automated, validated, audited, and exposed to agents without separate glue for each surface.

If you only need a static site or a single custom API endpoint, start with a simpler tool.
