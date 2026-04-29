---
title: Security
section: guides
order: 5
description: ACL best practices, SSRF protection, fail-closed design
tags: [guide, security]
---

# Security

Treenix's security model is **fail-closed**: when in doubt, deny. This guide covers practical security patterns.

## Principle: Deny by Default

Every security decision follows the same rule:

- No ACL on a node → **deny**
- ACL check throws an error → **deny**
- Unknown group → **deny**
- Unknown tool → **deny**
- Guard missing → **deny**

Never write `return { allowed: true }` as a default or fallback. The only way to grant access is an explicit allow rule.

```typescript
// WRONG — fails open
function checkAccess(user, node) {
  try {
    return evaluateAcl(user, node)
  } catch {
    return { allowed: true }  // ← security hole
  }
}

// RIGHT — fails closed
function checkAccess(user, node) {
  try {
    return evaluateAcl(user, node)
  } catch {
    return { allowed: false }
  }
}
```

## ACL Patterns

### Public read, authenticated write

```typescript
$acl: [
  { g: 'public',         p: R },       // anyone can read
  { g: 'authenticated',  p: R | W | S }, // logged in: read + write + subscribe
  { g: 'admins',         p: R | W | A | S }, // admins: full control
]
```

### Tenant isolation

```typescript
// /tenants/acme — sticky deny on public
$acl: [
  { g: 'tenant:acme',       p: R | W | S },
  { g: 'tenant:acme:admin', p: R | W | A | S },
  { g: 'public',            p: 0 },  // deny all, sticky
]
```

The sticky deny (`p: 0`) ensures no child node under `/tenants/acme/` can accidentally re-grant public access.

### Sensitive components — admin only

`register(type, 'acl', handler)` controls **component-level** access, not node-level. When the engine returns a node, `stripComponents` checks each named component against its type-level ACL and removes components the user can't read:

```typescript
register('secret.config', 'acl', () => [
  { g: 'admins', p: R | W | A | S },
])
```

A node might be readable, but its `secret.config` components will be stripped from the response for non-admins. Without a registered ACL handler, components default to full access.

For node-level restriction, set `$acl` directly on the node with a sticky deny.

## SSRF Protection

Mount adapters that connect to external URLs (tRPC federation, API adapters) must validate URLs:

- Reject private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1)
- Reject non-HTTP(S) schemes
- Whitelist allowed domains where possible
- Timeout all external requests (30s default)

## Action Security

Actions run on the server with full tree access. The engine provides safety mechanisms:

- **AbortSignal** — `getCtx().signal` aborts after 5 minutes (configurable via `ACTION_TIMEOUT` env)
- **OCC** — `$rev` prevents lost updates from concurrent mutations
- **Immer drafts** — sync actions can only mutate the draft, not arbitrary data
- **ACL check** — write permission is required to execute actions

## Secrets

- Never read `.env` files from application code — they contain deployment secrets
- Store API keys as node data with admin-only ACL
- The tree's ACL system protects secrets at rest — use it

## Input Validation

JSON Schema validation runs on every `tree.set()` in the server pipeline. Components with registered schemas are validated before persistence.

Action arguments are validated at runtime against JSON Schemas generated from TypeScript method signatures. The engine validates `data` before calling the handler — invalid arguments throw `BAD_REQUEST`.

If a type has no registered schema, the action is rejected in test/production (console.error in development). Schemas auto-generate on dev server startup; in CI, boot the server once against a throwaway store before running schema-dependent checks.

## Related

- [Concepts: ACL](../concepts/acl.md) — permission bits, groups, inheritance
- [Guide: Create a Mod](create-a-mod.md) — type-level ACL registration
