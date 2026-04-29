---
title: AI / MCP
section: concepts
order: 10
description: Type methods are MCP tools — agents call through the same pipeline humans do
tags: [core, ai, agents]
---

# AI / MCP

Methods on a registered [Type](./types.md) are exposed as MCP tools. Each method maps to `execute(path, method, data)`; parameters come from the [JSON Schema](./types.md#schema); results come back typed. `TodoItem.toggle` is callable by an agent without a separate tool definition.

```typescript
export class TodoItem {
  title = ''
  done = false

  /** @description Toggle done status */
  toggle() { this.done = !this.done }

  /** @description Update title */
  setTitle(data: { title: string }) { this.title = data.title }
}

registerType('todo.item', TodoItem)

// Every registered method is an MCP tool now:
// execute({ path: '/todos/buy-milk', action: 'toggle' })
// execute({ path: '/todos/buy-milk', action: 'setTitle', data: { title: 'Buy oat milk' } })
```

Connect Claude Code, Cursor, or any MCP client to your running Treenix instance and the agent sees every type, every method, every node as first-class tools.

## Security guardrails defined by the tree

Agent calls go through the standard pipeline:

- [**ACL**](./security.md#acl) check on the target node.
- [**Schema validation**](./security.md#validation) of the arguments.
- **Sandbox** for dynamic action code (QuickJS, no host filesystem/network/process access).
- Entry in the [**audit trail**](./audit.md).

Same path for agents. There's no "AI API" behind the scenes that skips these. If an agent isn't allowed to write `/finance/*`, the `execute` call fails at the same place a user's click would.

## Discovery — `catalog`, `describe_type`, `search_types`

MCP exposes three introspection tools on top of the per-method tools:

```
catalog                               → every registered Type with summary
describe_type  { type: 'todo.item' }  → schema, methods, registered contexts
search_types   { query: 'invoice' }   → keyword search across types
```

Agents use these to decide what tools to call. You keep [JSDoc](./types.md#jsdoc-annotations) descriptions tight; the agent reads them.

## The end-to-end path

```
Agent (MCP client)                  Treenix server                Tree
     │                                    │                          │
     │─ execute({path,action,data}) ─→ │                          │
     │                                    │ ← [ACL on /path]         │
     │                                    │ ← [Validate data]        │
     │                                    │ ← [Run method (Immer)]   │
     │                                    │ ── tree.patch ─────────→ │
     │                                    │                          │── broadcast
     │                                    │ ← [Stamp $lineage.by]    │
     │ ← { rev, patch } ────────── │                          │
     │                                                                │
     └── reads /path via describe/tree.get ─────────────────────────→│
```

No separate tool registry to keep in sync. The same class that drives the UI drives the agent.

## Same tree, same reality

Because the agent reads and writes the same [nodes](./composition.md#node) as humans:

- Two users + an agent triaging their inbox all reconcile through [Reactivity](./reactivity.md). A human clicking "assign" and an agent calling `assign` produce indistinguishable [patches](./reactivity.md).
- The [audit trail](./audit.md) carries `by: 'agent:*'` alongside `by: 'user:*'`. Queries filter; they don't need separate tables.
- Revoking the agent's access is an [ACL](./security.md#acl) change on the subtree, not a code deploy.

## When to use which surface

| Agent goal | Use |
|---|---|
| "Read state" | `tree.get`, `tree.getChildren`, `describe_type` |
| "Perform a mutation" | per-method tool (`execute(path, method, data)`) |
| "Follow changes" | subscription over MCP (same SSE stream as clients) |
| "Propose something for review" | write to a queue node, a [workflow](./roadmap.md) picks it up |

Prefer per-method tools over ad-hoc prompts. Typed actions succeed or fail loudly; schema errors come back as structured responses the agent can recover from.

## Related

- [Type](./types.md) — where MCP tools come from
- [Security](./security.md) — the gates every agent call passes
- [Audit Trail](./audit.md) — how agent writes are tracked
- [Reactivity](./reactivity.md) — how agents observe changes
- [Context](./context.md) — `action:*` contexts are what MCP exposes
