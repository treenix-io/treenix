# Treenix

**Composable app engine.** What Unity did for games, Treenix does for AI-native apps.

Tree of typed components with context-aware rendering. Inspired by Unity3D ECS, Plan9 filesystem, Unix pipes.

## Core Ideas

- **Everything is a node.** Files, users, configs, AI agents — all nodes in one tree.
- **ECS composition.** Attach any component to any node. No inheritance, no migration hell.
- **Context-aware rendering.** Same data, different views — React, Telegram, CLI, AI.
- **MCP-native.** Every node is AI-addressable out of the box.
- **Core < 500 lines.** Zero dependencies. Two npm packages.

## Three Primitives

```typescript
Component = { $type: string } & Data    // what it IS
Node      = { $path, $type, ...components }  // where it LIVES
Context   = Map<type+context, handler>   // how it BEHAVES
```

## Quick Start

```bash
npx -y create-treenix my-app
cd my-app
npm run dev
```

## Packages

| Package | Description |
|---------|-------------|
| `@treenx/core` | Engine: nodes, components, contexts, tree adapters, server, MCP |
| `@treenx/react` | React binding: hooks, admin shell, Inspector |
| `@treenx/agent-client` | Headless Node.js client for AI agents |
| `@treenx/recall` | Standalone RAG: BM25 + vector hybrid search |

## Mods

Official modules included in this repo:

| Mod | Description |
|-----|-------------|
| `board` | Kanban task board |
| `brahman` | Telegram bot builder (visual flow) |
| `cafe` | Contact form demo |
| `doc` | Rich text document editor |
| `launcher` | App launcher / dashboard |
| `mindmap` | Interactive mind map |
| `sim` | AI agent simulation |
| `three` | 3D scene editor (Three.js) |
| `todo` | Todo list |
| `whisper` | Notification inbox |

## Architecture

```
Layer 0: Node + Component + Context + Ref (core)
Layer 1: Storage adapters (Mongo/FS/Memory)
Layer 2: React binding, Telegram binding
Layer 3: Queries, children filtering
Layer 4: Mounts, external API adapters
Layer 5: tRPC/REST/MCP exposure
Layer 6: LLM integration
```

Lower layers never know about upper layers. Core has zero dependencies.

## License

Licensed under FSL-1.1-MIT. Free to use for any purpose. Converts to MIT automatically after two years from each release date.
