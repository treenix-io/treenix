---
title: Roadmap
section: concepts
order: 11
description: What ships today, what's next — Federation, Mod Marketplace
tags: [roadmap, federation, mods]
---

# Roadmap

The mechanics ship today. Discovery, storefront, and polish are next.

The [Tree](./tree.md), [Types](./types.md), [Contexts](./context.md), [Security](./security.md), [Reactivity](./reactivity.md), [Audit Trail](./audit.md), and [AI / MCP](./ai-mcp.md) are running in production right now. The two items below describe the layer on top — cross-org discovery and a curated mod catalog.

## Federation {#federation}

Your [Tree](./tree.md) mounts into someone else's over `t.mount.tree.trpc`. Each side publishes the subtrees it chooses to expose; everything else stays private behind [ACL](./security.md#acl).

```
you.treenix.io/
├── /mods
└── /upstream  ← t.mount.tree.trpc(...)
```

**Ships today:** the mounting mechanic. Two instances can connect; remote nodes look local; ACL holds at the boundary. See [Composition → Forest](./composition.md#forest) and [Mounts](./mounts.md).

**On the roadmap:** cross-org discovery (how do you find someone to federate with), trust policies (what contract you agree to expose), revocation flows.

## Mod Marketplace {#mod-marketplace}

A mod is [Types](./types.md) + [Views](./context.md#views) + [Services](./context.md#services) + optional workflow logic, packaged as one folder. Operators publish what they've shipped; others mount it.

**Ships today:** mods compose. Drop a folder into `mods/`, restart, and convention files (`types.ts`, `seed.ts`, `service.ts`, `view.tsx`) flow through the normal pipeline. Today's Treenix already runs a double-digit set of internal mods composing this way (flow, memory, ontology, org, tagger, tenants, brahman, jitsi, resim, pult, and more).

**On the roadmap:** storefront curation, versioned installs, dependency graphs, revocation and signature checks on install.

## How to read this page

The honest intent: **don't promise speculative features as shipped**. The rest of the docs describe what you can build today. This page is the one place where near-term plans live, so nothing else has to hedge.

If a concept you're reading elsewhere links here, that link is a marker that the mechanism works now, but the surrounding UX is still being polished.

## Related

- [Composition → Forest](./composition.md#forest) — the mounting primitive behind federation
- [Mounts](./mounts.md) — every adapter that federation composes from
- [Overview](./overview.md) — the shipped spine
- [Zen of Treenix](./zen.md) — the principles that keep the core stable while the edges move
