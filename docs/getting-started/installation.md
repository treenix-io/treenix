---
title: "Quickstart & Setup"
description: "Create a project, run the dev server, and make the first change"
section: getting-started
order: 1
tags: [getting-started, beginner]
---

# Quickstart & Setup

This guide creates a Treenix project, starts the local app, and verifies that actions and realtime updates work.

## Requirements

- Node.js 22+
- npm 9+

## Create a Project

```bash
npx -y create-treenix my-app
cd my-app
```

`create-treenix` downloads the starter from `treenix-io/starter`, installs dependencies, and prints the next command. The `-y` belongs to `npx`; it prevents npm from asking before it installs the CLI package.

## Run It

```bash
npm run dev
```

Open http://localhost:3210.

The Vite dev server serves the frontend on `3210`. The Treenix server runs on `3211` behind the same dev process, and Vite proxies `/trpc` and `/api` to it.

## Verify the Demo

Open http://localhost:3210/t/example/counter.

You should see the Inspector for the seeded counter node. Click **increment**.

Expected result:

- the counter value changes;
- refreshing the page keeps the latest value;
- opening the same URL in a second tab shows live updates when you click **increment** in the first tab.

If the node does not load, check the terminal running `npm run dev` first. Schema, import, and mount errors show there.

## Add Your First View

The demo node already has a Type. To render it yourself, register a React view from a mod's client entry:

```typescript
import { register } from '@treenx/core'
import type { View } from '@treenx/react/context'
import { useActions } from '@treenx/react/context'
import { ExampleCounter } from './types'

const CounterView: View<ExampleCounter> = ({ value }) => {
  const actions = useActions(value)

  return (
    <button className="rounded border px-3 py-2" onClick={() => actions.increment()}>
      {value.count} — add one
    </button>
  )
}

register(ExampleCounter, 'react', CounterView)
```

Client changes hot-reload. Server-side Type and seed changes require restarting `npm run dev`.

## What Happened

The counter click called a Type method as an action. Treenix validated the call, checked permissions, persisted the mutation, and streamed a patch to subscribed clients.

You do not need to understand the whole pipeline to keep going. The [Tutorial](./tutorial.md) walks through creating your own Type, seed data, actions, and views.

## Next

- [Tutorial](./tutorial.md) — build a bookmark manager.
- [Project Structure](./project-structure.md) — learn the starter layout.
- [Thinking in Treenix](./thinking-in-treenix.md) — learn the modelling style.
