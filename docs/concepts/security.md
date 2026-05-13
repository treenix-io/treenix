---
title: Security
section: concepts
order: 8
description: Two layers guard every tree operation — ACL decides who, Validation decides what
tags: [core, security]
---

# Security

Two layers guard every operation on the [tree](./tree.md):

- [**ACL**](#acl) — who can do it. Group-based, inherited down the tree, fail-closed.
- [**Validation**](#validation) — what a mutation or call may carry. JSON Schema from the [Type](./types.md), rejected before it touches storage.

Same path for [agents](./ai-mcp.md). Human users, services, and AI callers go through identical checks — there's no "admin API" they can reach around.

A third layer — **QuickJS sandboxing** for untrusted code (user snippets, agent-authored actions, marketplace mods) — is shipping; docs will land once the public surface settles. For the pipeline today, ACL and Validation cover every tree write.

## ACL {#acl}

Declared on a node as `$acl` — an array of group-permission entries, inherited by every descendant. Checked on every read, write, and action, including [agent](./ai-mcp.md) calls. **Fail-closed by default.**

```typescript
import { R, W, A, S } from '@treenx/core'

{
  $path: '/secrets/keys',
  $type: 'config',
  $owner: 'admin-user',
  $acl: [
    { g: 'admins',        p: R | W | A | S },
    { g: 'authenticated', p: R | S },
    { g: 'public',        p: 0 },             // deny all (sticky)
  ],
}

// R = read, W = write, A = admin, S = subscribe
```

### Permission bits

| Bit | Value | Name | Meaning |
|---|---|---|---|
| R | 1 | Read | See the node and its data |
| W | 2 | Write | Modify the node |
| A | 4 | Admin | Change ACL, change owner |
| S | 8 | Subscribe | Receive realtime updates |

Combine via bitwise OR: `R | W = 3`, `R | W | A | S = 15`.

### Permission values — allow, deny, sticky-deny

| `p` value | Meaning | Behavior |
|---|---|---|
| `p > 0` | Allow specific bits | Grant the listed permissions |
| `p = 0` | Deny all | Block everything — **sticky**, cannot be re-granted deeper |
| `p < 0` | Deny specific bits | Block the listed bits (by absolute value) — **sticky** |

**Sticky** means once a group is denied, no child node can re-grant it. If `/secrets` has `{ g: 'public', p: 0 }`, `/secrets/keys` cannot grant `public` back — even by listing it with positive permissions.

### Inheritance — allows add, denies stick

ACL accumulates down the tree. The resolver walks every ancestor, collecting per-group permissions. **Allows are additive**: a child can widen a parent grant. **Denies are sticky**: once denied, a group stays denied in the subtree.

```
/                $acl: [{ g: 'public', p: R }, { g: 'authenticated', p: R | S }]
/admin           $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'public', p: 0 }]
/admin/settings  (no $acl)
```

At `/admin/settings`:

- `public` → sticky-denied from `/admin` — **blocked**, even though root granted `R`.
- `authenticated` → `R | S` inherited from root — **still active**, `/admin` didn't deny it.
- `admins` → `R | W | A | S` from `/admin`.

**Watch out:** adding an `admins` rule does NOT make a subtree private. Other groups' allows carry forward unless you explicitly deny them with `p: 0`.

### Component-level ACL

`register(TypeName, 'acl', handler)` sets ACL for **Components**, not Nodes. When the engine serves a node, it strips components the caller can't read:

```typescript
import { R, W, A, S } from '@treenx/core'
import { register } from '@treenx/core'

// Only admins can see 'groups' components on any node
register('groups', 'acl', () => [
  { g: 'admins', p: R | W | A | S },
])
```

Without a registered handler, components default to full access (`R | W | A`). This is not a replacement for node-level ACL — node access is controlled exclusively by `$acl`.

### Owner

`$owner` records who created the node. It does **not** implicitly grant any permissions. To give owners special access, add the `owner` pseudo-group to the ACL:

```typescript
{
  $path: '/tasks/mine',
  $type: 'todo.task',
  $owner: 'user-123',
  $acl: [
    { g: 'owner',         p: R | W | A },
    { g: 'authenticated', p: R | S },
  ],
}
```

`owner` matches when the caller's ID equals the node's `$owner`. Without an explicit `{ g: 'owner', ... }` entry, the owner has no privileges beyond what other groups grant.

### Multi-tenant example

```typescript
{
  $path: '/tenants/acme',
  $type: 'dir',
  $acl: [
    { g: 'tenant:acme',       p: R | W | S },
    { g: 'tenant:acme:admin', p: R | W | A | S },
    { g: 'public',            p: 0 },
  ],
}
```

The sticky-deny on `public` ensures no child node can accidentally expose data.

### Fail closed

- No ACL on a node and no inherited ACL → **deny**.
- ACL check throws → **deny**.
- Unknown group → **deny**.
- Unknown permission → **deny**.

Never `return { allowed: true }` as a fallback. The default for any permission check is denial.

## Validation {#validation}

Every mutation and action is checked against the JSON Schema generated from the [Type](./types.md#schema). Wrong shape → rejected before it touches storage. Same check for human clients, services, and [agents](./ai-mcp.md).

```typescript
import { registerType } from '@treenx/core'

export class Invoice {
  amount = 0         // number
  currency = 'USD'   // string

  /** @description Charge the invoice */
  charge(data: { method: 'card' | 'wire' }) { /* ... */ }
}
registerType('acme.invoice', Invoice)

// Runtime rejects anything off-schema
execute('/acme/invoice/42', 'charge', { method: 'crypto' })
// → ValidationError: method must be one of ['card', 'wire']
```

The schema is derived from the class at boot — fields, enums, required keys, method parameters. Forms, agents, and storage share one source of truth. See [Type → Schema](./types.md#schema) for generation details and JSDoc annotations that shape it.

### What's validated

- **Node shape** on `tree.set` — every required field present, types match.
- **Action params** on `execute` — the method's `data` argument matches its declared parameters.
- **Enum values** — rejected if outside the declared set.
- **Required fields** — rejected if missing.

Validation runs before [persistence](./types.md#storage) and before the [lineage stamp](./audit.md). A rejected write leaves the node untouched.

## Related

- [Composition](./composition.md) — `$acl` and `$owner` as system fields
- [Type → Schema](./types.md#schema) — how schemas are generated for validation
- [Audit Trail](./audit.md) — every accepted write is stamped with who and when
- [AI / MCP](./ai-mcp.md) — agents go through the same ACL + Validation pipeline
- Guide: [Secure an App](../guides/security.md) — SSRF protection, best practices
