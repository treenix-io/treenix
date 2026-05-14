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

## Dev Mode — passwordless login + MCP

`NODE_ENV=development` (set automatically by `npm run dev`) flips two switches:

- **`VITE_DEV_LOGIN=1`** — the browser at http://localhost:3210 signs you in as a local admin without a password. Useful for the first ten minutes; do not ship it.
- **`MCP_DEV_ADMIN=1`** — the MCP endpoint at `http://localhost:3211/mcp` accepts unauthenticated calls from loopback.

On boot you see a yellow banner:

```
⚠️  DEV MODE — UNAUTHORIZED ADMIN ACCESS ENABLED
   MCP: http://localhost:3211/mcp
   Loopback only. Do not expose this port externally.
   Disable: NODE_ENV=production (or MCP_DEV_ADMIN=0 / VITE_DEV_LOGIN=0)
```

Production refuses to boot if `VITE_DEV_LOGIN` is set with `NODE_ENV !== development` — the dev-login route never reaches a non-development build.

### Connect an MCP client

Point any MCP-aware tool at `http://localhost:3211/mcp`. The endpoint speaks the standard streamable-HTTP MCP protocol; no token is required while `MCP_DEV_ADMIN=1`.

```bash
# Claude Code
claude mcp add --transport http treenix-dev http://localhost:3211/mcp
```

Claude Desktop, Cursor, Codex, and other clients accept the same URL via their own MCP config file (usually a JSON entry with `"url": "http://localhost:3211/mcp"`). For Codex/Claude setup and Treenix skills, see [Setup MCP and Skills](../guides/setup-mcp-and-skills.md). Once connected, every registered Type and method becomes a tool the agent can call; see [AI / MCP](../concepts/ai-mcp.md).

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
import { useActions, view, type View } from '@treenx/react'
import { ExampleCounter } from './types'

const CounterView: View<ExampleCounter> = ({ value }) => {
  const actions = useActions(value)

  return (
    <button className="rounded border px-3 py-2" onClick={() => actions.increment()}>
      {value.count} — add one
    </button>
  )
}

view(ExampleCounter, CounterView)
```

Client changes hot-reload. Server-side Type and seed changes require restarting `npm run dev`.

## What Happened

The counter click called a Type method as an action. Treenix validated the call, checked permissions, persisted the mutation, and streamed a patch to subscribed clients.

You do not need to understand the whole pipeline to keep going. The [Tutorial](./tutorial.md) walks through creating your own Type, seed data, actions, and views.

## Next

- [Tutorial](./tutorial.md) — build a bookmark manager.
- [Project Structure](./project-structure.md) — learn the starter layout.
- [Thinking in Treenix](./thinking-in-treenix.md) — learn the modelling style.
