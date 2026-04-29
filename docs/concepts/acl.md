---
title: ACL
section: concepts
order: 7
description: Bitmask permissions with group inheritance and fail-closed security
tags: [core, security]
---

# ACL

Treenix uses a bitmask permission system. Each node can carry an `$acl` field — an array of group-permission pairs that controls who can read, write, administer, or subscribe.

```typescript
{
  $path: '/secrets/keys',
  $type: 'config',
  $owner: 'admin-user',
  $acl: [
    { g: 'admins',         p: 15 },  // R + W + A + S (all)
    { g: 'authenticated',  p: 9 },   // R + S (read + subscribe)
    { g: 'public',         p: 0 },   // deny all (sticky)
  ],
}
```

## Permission Bits

Four permission bits, combined via bitwise OR:

| Bit | Value | Name | Meaning |
|-----|-------|------|---------|
| R | 1 | Read | See the node and its data |
| W | 2 | Write | Modify the node |
| A | 4 | Admin | Change ACL, change owner |
| S | 8 | Subscribe | Receive realtime updates |

Combine them: `R | W = 3` (read + write), `R | W | A | S = 15` (everything).

```typescript
import { R, W, A, S } from '@treenx/core'
```

## Permission Values

The `p` field in a group-permission pair has three modes:

| Value | Meaning | Behavior |
|-------|---------|----------|
| `p > 0` | Allow bits | Grant the specified permissions |
| `p = 0` | Deny all | Block everything, **sticky** — cannot be overridden by child rules |
| `p < 0` | Deny bits | Block specific bits (absolute value), **sticky** |

**Sticky** means deny rules can't be overridden deeper in the tree. If `/secrets` denies public access, `/secrets/keys` can't re-grant it.

## Inheritance

ACL accumulates down the tree from root to target path. The algorithm walks every ancestor, collecting permissions per group. **Allows are additive** — a child can widen permissions granted by a parent. **Denies are sticky** — once a group is denied, no child can re-grant it.

```
/              $acl: [{ g: 'public', p: 1 }, { g: 'authenticated', p: 9 }]
/admin         $acl: [{ g: 'admins', p: 15 }, { g: 'public', p: 0 }]
/admin/settings (no $acl)
```

At `/admin/settings`:
- `public` has `p: 0` (sticky deny from `/admin`) — **blocked**, even though root granted `R`
- `authenticated` has `p: 9` (inherited from root) — **still active**, because `/admin` didn't deny it
- `admins` has `p: 15` (from `/admin`) — full access

**Important:** adding an `admins` rule does NOT make a subtree private. Other groups' allows carry forward unless explicitly denied. To make a subtree private, you must **deny** unwanted groups with `p: 0`.

## Component-level ACL

`register(type, 'acl', handler)` sets ACL for **components**, not nodes. When the engine returns a node, `stripComponents` checks each named component against its type-level ACL and removes components the user doesn't have permission to read.

```typescript
import { R, W, A, S } from '@treenx/core'
import { register } from '@treenx/core'

// Only admins can see 'groups' components on user nodes
register('groups', 'acl', () => [
  { g: 'admins', p: R | W | A | S },
])
```

A node might be readable, but specific components within it might be stripped from the response. Without a registered ACL handler, components default to full access (`R | W | A`).

This is NOT node-level ACL. Node access is controlled exclusively by the `$acl` field on nodes.

## Fail Closed

Treenix's security model is **fail closed**:

- No ACL on a node and no inherited ACL → **deny**
- ACL check throws an error → **deny**
- Unknown group → **deny**
- Unknown permission → **deny**

Never `return { allowed: true }` as a fallback. The default for any permission check is denial.

## Owner

The `$owner` field records who created the node. It does **not** implicitly grant any permissions. To give owners special access, add the `owner` pseudo-group to the ACL:

```typescript
{
  $path: '/tasks/my-task',
  $type: 'todo.task',
  $owner: 'user-123',
  $acl: [
    { g: 'owner', p: R | W | A },     // owner gets read + write + admin
    { g: 'authenticated', p: R | S },  // others can read + subscribe
  ],
}
```

The `owner` pseudo-group matches when the requesting user's ID equals the node's `$owner` field. Without an explicit `{ g: 'owner', p: ... }` rule, the owner has no special privileges.

## Example: Multi-tenant Setup

```typescript
// Tenant root — only tenant members can access
{
  $path: '/tenants/acme',
  $type: 'dir',
  $acl: [
    { g: 'tenant:acme',    p: R | W | S },  // tenant members: read, write, subscribe
    { g: 'tenant:acme:admin', p: R | W | A | S },  // tenant admins: full
    { g: 'public',          p: 0 },  // everyone else: denied (sticky)
  ],
}
```

Everything under `/tenants/acme/*` inherits these rules. The sticky deny on `public` ensures no child node can accidentally expose data.

## Related

- [Nodes](nodes.md) — system fields including $acl and $owner
- [Tree](tree.md) — server pipeline applies ACL checks
- [Guide: Security](../guides/security.md) — SSRF protection, best practices
