# @treenity/core

**A spatial protocol for typed data. Three primitives. Everything else composes.**

A single business concept — say, an Order — lives in five places: database schema, ORM, API DTO, frontend state, validation rules. Each copy drifts. Each sync layer adds bugs. Meanwhile, AI agents drown in infinite code grammar with no structural guardrails.

Treenity solves this with three primitives:

```
Node      = { $path, $type, ...components }
Component = { $type, ...data }
Context   = (Type, Context) → Handler
```

## Install

```bash
npm install @treenity/core
```

Or scaffold a full project:

```bash
npx create-treenity my-app
```

## Quick Example

```typescript
import { registerType } from '@treenity/core/comp';

class TodoItem {
  title = '';
  done = false;

  toggle() {
    this.done = !this.done;
  }
}

registerType('todo.item', TodoItem);
```

Fields = data schema. Methods = server-side actions. `toggle()` runs inside an Immer draft — mutate `this` freely, patches are generated and broadcast to subscribers.

```typescript
// React — one hook, fully typed
const item = usePath('/todo/list/1', TodoItem);
item.title;          // reactive read
await item.toggle(); // tRPC mutation → Immer patch → SSE broadcast
```

## What You Get for Free

| Feature | How |
|---|---|
| **Persistence** | Memory, filesystem, or MongoDB — composable store wrappers |
| **Real-time sync** | SSE subscriptions, open two tabs and changes sync |
| **Type validation** | JSON schemas auto-generated from classes |
| **ACL** | Per-node bitmask permissions inherited down the tree |
| **AI access** | Every node readable via MCP — Claude can query and mutate your data |
| **Multi-surface** | Same type renders in React, Telegram, CLI — register context handlers |
| **Mounts** | Mount MongoDB, REST APIs, other Treenity instances into one namespace |

## Packages

- **@treenity/core** — primitives, store, server, schema, actions
- **@treenity/react** — hooks, admin UI, reactive cache

## Links

- [Getting Started](https://github.com/treenity-ai/treenity/blob/main/docs/getting-started.md)
- [Architecture & Decisions](https://github.com/treenity-ai/treenity/blob/main/CLAUDE.md)
- [GitHub](https://github.com/treenity-ai/treenity)

## License

Licensed under FSL-1.1-MIT. Free to use for any purpose. Converts to MIT automatically after two years from each release date.
