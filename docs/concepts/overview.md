---
title: Overview
section: concepts
order: 0
description: What Treenix is made of — three primitives, and everything built on them
tags: [core, beginner, overview]
---

# Overview

Treenix is a platform you build on by [typing your data](./types.md). Every value lives as a [Node](./nodes.md) on a typed [Tree](./tree.md). Every behavior — rendering, storage, permissions, agent access — is chosen by [Context](./context.md). Nothing else is special.

That's the whole spine:

- A [**Component**](./composition.md#component) is a piece of typed data.
- A [**Node**](./composition.md#node) is an addressable path carrying one main Component and any number of extra ones.
- A [**Context**](./context.md) is the registry that decides which [View](./context.md#views), [service](./context.md#services), validator, or agent tool handles a given Type in a given situation.

From those three, the rest composes: the [Tree](./tree.md) as the universal data interface, [Mounts](./mounts.md) to pull external systems in, [Reactivity](./reactivity.md) to keep clients in sync, [Security](./security.md) to gate every access, an [Audit Trail](./audit.md) that names every writer, [MCP](./ai-mcp.md) to expose Type methods as agent tools.

## Who this section is for

If you finished the [Tutorial](../getting-started/tutorial.md) and [Thinking in Treenix](../getting-started/thinking-in-treenix.md), you've already used the spine. This section explains each primitive with enough depth that the patterns in the [Guides](../guides/create-a-mod.md) read as natural consequences.

Read roughly top-to-bottom for a single-pass overview. Skip around when hunting a specific concept.

## What to read

- [**Composition**](./composition.md) — Component → Node → Tree → Forest. Where "a task is also a thread" comes from.
- [**The Tree**](./tree.md) — paths, children by prefix, subscriptions by prefix.
- [**Type**](./types.md) — write a class, get storage, schema, RPC, forms, reactivity, MCP.
- [**Contexts**](./context.md) — one node, many surfaces.
- [**Reactivity**](./reactivity.md) — optimistic → commit → patch → observe.
- [**Mounts**](./mounts.md) — bring external systems into the same tree.
- [**Security**](./security.md) — ACL (who) and Validation (what) on every call.
- [**Audit Trail**](./audit.md) — who/when/via/origin for every mutation.
- [**AI / MCP**](./ai-mcp.md) — agents call through the same pipeline humans do.
- [**Roadmap**](./roadmap.md) — what ships today, what's coming.
- [**The Zen of Treenix**](./zen.md) — the constraints that made the shape possible.

## Three audiences, same platform

- **Developers** — familiar TypeScript and React, every layer exposed.
- **Vibecoders** — agents know the platform from the inside and compose ready-made [mods](../guides/create-a-mod.md). Building blocks ship production-grade.
- **Operators** — Treenix [mounts](./mounts.md) existing systems alongside and grows with the organization, aggregating data and tools into one surface.

## Related

- [Introduction](../index.md) — the one-page framing
- [Tutorial](../getting-started/tutorial.md) — see the spine in action
- [Build a Mod](../guides/create-a-mod.md) — use it for real work
