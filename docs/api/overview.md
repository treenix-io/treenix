---
title: Reference Overview
section: api
order: 0
description: How the Reference is organized — hand-written hooks, live Type Catalog, JSON Schemas
tags: [reference]
---

# Reference Overview

The Reference covers the surfaces you can use today:

1. **[Hooks & APIs](./hooks.md)** — the core React hooks and low-level functions you import day-to-day (`usePath`, `useChildren`, `useActions`, `execute`, `register`). Hand-written, one section per symbol, with examples.
2. **Type Catalog** — a live listing of registered [Types](../concepts/types.md) exposed by the running instance through `/sys/types` when the `t.mount.types` mount is enabled.
3. **JSON Schemas** — generated into `schemas/*.json` directories next to the Type source files. Forms, [validation](../concepts/security.md#validation), and [MCP tool definitions](../concepts/ai-mcp.md) all compose from these.

## Freshness

| Surface | Where it lives | When it updates |
|---|---|---|
| Hooks & APIs | Hand-written markdown | When this doc is updated |
| Type Catalog | Live `/sys/types` | When the running instance loads Types |
| JSON Schemas | `schemas/*.json` beside Type source files | On server boot |

## Why not TypeDoc everywhere?

TypeDoc generates a complete API listing from TypeScript declarations. It's reliable and unambiguous — but stripped of the one thing docs need: shape and usage. A hand-written hook reference can order symbols by how often you reach for them, and show the patterns that make them work together.

This page stays intentionally small: the core hooks and the handful of APIs most apps touch. Use generated schemas and source JSDoc for the long tail.

## Related

- [Hooks & APIs](./hooks.md) — the core-5 reference
- [Type](../concepts/types.md) — where schemas come from
- [AI / MCP](../concepts/ai-mcp.md) — `catalog`, `describe_type`, `search_types` MCP tools
