---
title: Composition
section: concepts
order: 1
description: Component → Node → Tree → Forest — ECS on a typed tree
tags: [core, beginner, architecture]
---

# Composition

How the pieces fit together.

- **Component → Node.** Typed aspects clip onto one [Node](#node), which *is* itself a Component (its main one).
- **Node → [Tree](./tree.md).** Paths compose children; the tree is the filesystem.
- **Tree → Forest.** Trees [mount](./mounts.md) each other; [federation](./roadmap.md#federation) is the boundary.

Three steps, same idea at every scale.

## Component {#component}

A Component is one typed aspect — a [Type](./types.md) instance with its fields. Multiple Components clip onto a single Node by key, each rendering and reacting independently.

```typescript
// one node, system fields + main component fields + keyed components
{
  // system fields (core)
  $path:  '/acme/projects/2026',
  $type:  'project',
  $owner: 'alice',
  $acl:   [
    { g: 'admins', p: R | W | A | S },
    { g: 'viewer', p: R },
  ],

  // main component fields — live at node level because node.$type === 'project'
  title:  'Q2 website',
  status: 'active',

  // additional components keyed by name, each with its own $type
  billing:  { $type: 'acme.billing',  rate: 150 },
  schedule: { $type: 'acme.schedule', start: '2026-04-01' },
  chat:     { $type: 'chat',          messages: [] },
}
```

**System fields** (`$path`, `$type`, `$owner`, `$acl`) live at node level. [ACL](./security.md#acl) is a `GroupPerm[]` array of `{ g, p }` entries with bitflag permissions (`R | W | A | S`).

**Main component fields** live directly at node level — because `node.$type` defines the main component, its fields aren't hidden behind a key.

**Extra components** attach under a key with their own `$type`. Any [Type](./types.md) can attach to any Node — that's how "one task is also a forum thread" works.

This is ECS composition instead of inheritance. Adding a capability is adding a Component, not extending a class.

### Reading Components

`getComponent(node, Class)` or `getComponent(node, typeName)` — both work. The key: `getComponent` checks `node.$type` *first*. If the requested Type matches the node's main Type, the **node itself** is returned as the Component.

```typescript
import { getComponent } from '@treenx/core'

// Main component: returns the node (title + status live at node level)
getComponent(node, Project)             // { $path, $type: 'project', title, status, ... }

// Named component: returns the keyed entry
getComponent(node, 'acme.billing')      // { $type: 'acme.billing', rate: 150 }
```

**Common mistake:** duplicating the main Component in a keyed entry.

```typescript
// WRONG — the 'project' key is ignored; main fields must live at node level
{ $type: 'project', project: { $type: 'project', title: 'X' } }

// RIGHT
{ $type: 'project', title: 'X' }
```

See [Types](./types.md) for registration and [Contexts](./context.md) for how Components render per surface.

## Node {#node}

A Node is a typed, addressable entity. It carries exactly one main Component (from `$type`) and any number of extras by key. Its unique address is `$path`.

```
/                               root
/acme                           a directory
/acme/projects                  another directory
/acme/projects/2026             a Project node
/acme/projects/2026/invoices    a child of the project
```

Children of a Node are any Node whose `$path` extends the parent's — discovered by prefix query, not stored inside the parent.

```typescript
import type { Tree } from '@treenx/core/tree'

declare const tree: Tree

await tree.getChildren('/acme/projects')   // every direct child under /acme/projects
await tree.get('/acme/projects/2026')      // one node
```

Prefix gives you structure, containment, and [subscription scope](./reactivity.md) at the same time. Subscribing to `/acme/projects` watches every project's changes in one stream.

### System fields and naming

| Field | Purpose |
|---|---|
| `$path` | Absolute path |
| `$type` | Type identifier — selects the main Component |
| `$rev` | Revision for optimistic concurrency control |
| `$owner` | User ID of the node's owner |
| `$acl` | Access control list ([see Security](./security.md#acl)) |
| `$refs` | Internal reference tracking |

Type names follow `{namespace}.{name}`:

| Pattern | Examples | Meaning |
|---|---|---|
| No dot | `dir`, `ref`, `root`, `user` | Core built-ins |
| `t.*` | `t.mount.fs`, `t.mount.mongo` | Treenix infrastructure |
| `{vendor}.*` | `acme.project`, `cafe.order` | Application types |

Separator is always `.` — not `/`, not `@`, not `:`.

### Creating nodes

```typescript
import { makeNode } from '@treenx/core'

const node = makeNode('/acme/projects/2026', 'project', {
  title: 'Q2 website',
  status: 'active',
})
```

Never build `{ $path, $type, ... }` by hand — `makeNode` validates system field names and normalizes Types.

## Forest {#forest}

Your [Tree](./tree.md) can mount someone else's subtree over `t.mount.tree` (or any other [Mount](./mounts.md)). Remote Nodes look local; [ACL](./security.md#acl) stays at the boundary. Many trees, one navigable Forest.

```
you.treenix.io/
├── /acme
└── /partner  ← t.mount.tree(globex.io)
```

Each tree publishes what others should see. Everything else stays private behind policy. The mounting mechanic ships today; cross-org curation and trust policies come with [Federation](./roadmap.md#federation).

```typescript
// Your root.json
{
  "mount": { "$type": "t.mount.overlay", "layers": [
    { "$type": "t.mount.fs",        "root": "data/local" },
    { "$type": "t.mount.tree.trpc", "url":  "https://globex.io/trpc" },
  ]}
}
```

To your app, `/partner/projects/alpha` is just another path. Reads proxy to the remote tree; writes respect both sides' [ACL](./security.md#acl). The [Tree](./tree.md) interface is all the code sees.

## Related

- [The Tree](./tree.md) — the interface under everything
- [Types](./types.md) — what each `$type` actually gives you
- [Contexts](./context.md) — how Components render per surface
- [Mounts](./mounts.md) — how external systems join the Forest
- [Security → ACL](./security.md#acl) — permission bits, inheritance, fail-closed
- Guide: [Build a Mod](../guides/create-a-mod.md) — compose these into a running feature
- Guide: [Federate Trees](../guides/mounts-federation.md) — production-ready mount topologies
