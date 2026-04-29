---
title: Glossary
section: resources
order: 2
description: One-line definitions of Treenix terms
tags: [reference, glossary]
---

# Glossary

Short definitions, each linking to its concept page.

**Action.** A method on a [Type](../concepts/types.md) class. Becomes an executable server call (`execute(path, method, data)`) and an MCP tool automatically. Call it from React with `useActions(value).method()`.

**ACL.** The `$acl` field on a node — an array of `{ g, p }` group-permission entries. Bit-flags: `R | W | A | S`. Inherited down the tree, fail-closed. See [Security → ACL](../concepts/security.md#acl).

**Agent.** An MCP client calling Treenix. Operates through the same pipeline as human users — [ACL](../concepts/security.md#acl), [Validation](../concepts/security.md#validation), [audit](../concepts/audit.md). See [AI / MCP](../concepts/ai-mcp.md).

**Audit Trail.** The `$lineage` stamped on every write — who, when, action, via, origin. Queryable, revertible. See [Audit Trail](../concepts/audit.md).

**Codec.** A plug-in that maps file formats to [Nodes](../concepts/composition.md#node). The `text/markdown` codec turns `.md` files into `doc.page` nodes; custom codecs can handle any MIME type.

**Component.** A typed aspect of a node. One main component (from `$type`) + any number of keyed extras. See [Composition → Component](../concepts/composition.md#component).

**Context.** A string that selects a handler at render time (`react`, `react:table`, `service`). Resolution cascade: exact → default → strip suffix → null. See [Contexts](../concepts/context.md).

**Federation.** Mounting another Treenix's subtree into yours via `t.mount.tree.trpc`. See [Roadmap → Federation](../concepts/roadmap.md#federation).

**Forest.** Multiple [Trees](../concepts/tree.md) composed via [Mounts](../concepts/mounts.md). Remote nodes look local; ACL stays at the boundary. See [Composition → Forest](../concepts/composition.md#forest).

**Guardian.** The runtime policy evaluator that decides whether an ACL rule applies to a caller.

**Immer draft.** The mutable-looking object handed to an [Action](../concepts/types.md#rpc). Mutations to the draft are turned into JSON Patches automatically.

**Inspector.** The built-in typed editor Treenix renders for any node that has no custom view. Forms, action buttons, and validation come from the [Schema](../concepts/types.md#schema).

**JSON Patch.** The wire format for mutations. Every mutation is expressed as a sequence of patch operations streamed to subscribers. See [Reactivity](../concepts/reactivity.md).

**Lineage.** The `$lineage` field — `by`, `at`, `action`, `via`, `origin`. See [Audit Trail](../concepts/audit.md).

**Mod.** A packaged folder of [Types](../concepts/types.md), [Views](../concepts/context.md#views), [Services](../concepts/context.md#services), and seed data. See [Build a Mod](../guides/create-a-mod.md).

**Mount.** A Node whose subtree is delegated to a storage adapter. See [Mounts](../concepts/mounts.md).

**MCP.** Model Context Protocol. Agents speak MCP; Treenix exposes every Type method as an MCP tool. See [AI / MCP](../concepts/ai-mcp.md).

**Node.** An addressable entity in the tree: `$path` + `$type` + one main Component + keyed extras. See [Composition → Node](../concepts/composition.md#node).

**OCC.** Optimistic Concurrency Control. Each node has a `$rev`; concurrent writers detect conflicts without locking.

**Patch.** See *JSON Patch*.

**Path.** A node's address, like a filesystem path (`/orders/123/items`). Children are discovered by prefix, not stored inside parents.

**Prefab.** A named collection of seed nodes deployed at startup. Registered via `registerPrefab(namespace, name, nodes)`.

**Query mount.** A virtual folder showing a filtered subset of another path. Changes track automatically via [CDC](../concepts/reactivity.md).

**Reactivity.** The optimistic → commit → patch → observe loop. See [Reactivity](../concepts/reactivity.md).

**Ref.** A pointer from one Node to another — `{ $type: 'ref', $ref: '/some/path' }`. Lazy; explicit deref needed.

**Schema.** JSON Schema generated from a Type class at boot. Drives forms, validation, MCP tool definitions. See [Type → Schema](../concepts/types.md#schema).

**Service.** A long-running handler pinned to a Node — context `service`. Lifecycle follows the node. See [Contexts → Services](../concepts/context.md#services).

**Subscription.** A live notification of mutations on a path or subtree. In React, `usePath` and `useChildren` wrap subscriptions. See [Reactivity](../concepts/reactivity.md).

**Tree.** The five-method data interface: `get`, `getChildren`, `set`, `remove`, `patch`. See [The Tree](../concepts/tree.md).

**Type.** A class registered with `registerType`. Gives you storage, schema, forms, RPC, MCP. See [Type](../concepts/types.md).

**TypeProxy.** What `usePath(path, Class)` returns as its `data`. Field reads subscribe reactively; method calls route to `execute()`.

**View.** A handler for a `(Type, 'react')` context — a React component that renders a node. See [Contexts → Views](../concepts/context.md#views).

## Related

- [Overview](../concepts/overview.md) — the three-primitive spine
- [The Zen of Treenix](../concepts/zen.md) — why these are the only concepts
