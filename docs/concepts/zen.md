---
title: The Zen of Treenix
section: concepts
order: 12
description: Layer model, "say NO" rules, dogfood, and why not React + Mongo
tags: [philosophy, architecture]
---

# The Zen of Treenix

Treenix is *not* a framework that does everything. It's a minimum protocol for addressability and manifestation — like URLs for the web: URLs don't replace pages, they give you a way to reference them. ~200 lines of core. Three primitives. That's the whole contract.

If something feels missing, the rule is: **look for the solution in a layer above, not by bloating the core.**

## The layer model

Lower layers never know about upper ones. Every new concept must pick a layer and stay there.

| Layer | Contents |
|---|---|
| **0** | [Node](./composition.md#node), [Component](./composition.md#component), [Context](./context.md), Ref — pure types and functions |
| **1** | [Tree](./tree.md) interface; memory, fs, mongo adapters; combinators (overlay, filter) |
| **2** | React binding; Telegram binding — any platform integration |
| **3** | Queries, children filtering, [Reactivity](./reactivity.md) |
| **4** | [Mounts](./mounts.md), external-API adapters |
| **5** | tRPC / REST exposure |
| **6** | LLM integration, [MCP](./ai-mcp.md) |

Core (L0) is ~200 lines. Zero runtime dependencies besides TypeScript. No React, no persistence, no decorators, no classes — plain objects and functions. Everything rich lives in layers above.

## Three primitives

```
Component = { $type: string } & Data
Node      = { $path, $type, ...components }
Context   = Map<(type, context), handler>
```

Every feature you use — [Views](./context.md#views), [Services](./context.md#services), [Validation](./security.md#validation), [Mounts](./mounts.md), [ACL](./security.md#acl), [Audit](./audit.md), [MCP](./ai-mcp.md) — is a handler registered against `(type, context)` and called against a `Node`. Nothing else is special. If you can explain a feature without reaching for a fourth primitive, it belongs. If you need a fourth, the feature probably doesn't.

## Say NO

We've killed three prototypes by saying YES too often: a Port/Link messaging system that became 19 files, decorators that hid logic, mounts built before the core was stable, shared types in `mods/types/` that grew invisible dependencies, RxJS for reactivity that pulled the dependency tree sideways. Forty thousand lines. Six people. Three dead prototypes. Ten years of life between them.

The refusals that keep the current spine alive:

1. **"We'll need it later."** No. Build only what a working use-case demands right now.
2. **"Let's make it flexible from the start."** No. Flexibility is combinatorial complexity. Rigid core, explicit extension points.
3. **"It's only 50 lines."** No. 50 lines × 20 features = 1,000 lines that interact. Complexity is quadratic.
4. **"Unity / React / Linux does it this way."** No. Different scale, different problems. Solve the one in front of us.
5. **"It can go in the core."** No. Can it be a plugin? Then it's a plugin. Core < 500 lines. Always.
6. **"We need an abstraction for these three similar things."** No. Three lines of duplication beat a premature abstraction.
7. **"This Component should know about its neighbors."** No. A Component knows its own data. Coordination lives outside.
8. **Cross-layer dependency.** No. Never. L2 doesn't know about L4. If you need it, the architecture is wrong.

When we say YES:

1. A concrete use-case doesn't work without the change.
2. The change is under 30 lines.
3. It introduces no new concepts.
4. It creates no cross-layer dependency.
5. It can be explained in one sentence.

**All five conditions together.** Not three of five. All.

## Check before every change

- [ ] Does this answer a real pain in a working use-case?
- [ ] Does the core stay under 500 lines?
- [ ] Zero new dependencies?
- [ ] Lower layers still ignorant of upper?
- [ ] Can a new developer understand this in ten minutes?
- [ ] Can you delete it without cascade breakage?

One ✗ — NO.

## Dogfood

Data lives in the [tree](./tree.md). Pipes live outside it.

If something becomes more useful by being a [Node](./composition.md#node) — addressable, permissioned, subscribable, visible to [agents](./ai-mcp.md) — it belongs in the tree. State, config, queues, workflows, feature flags, schedules: all nodes.

If it's just plumbing — transport, build tools, runtime pipes — it stays outside. Side-channels are a smell. Data that *should* be visible to users or agents but isn't in the tree is a bug, not a shortcut.

The working rule: **build Treenix with Treenix.** Tools that break this rule break first.

## Why not React + Mongo?

You *can* build what Treenix does on top of React + Mongo + a bag of libraries. People do. The cost isn't code — it's the seams. Each seam (auth across API, validation separate from forms, realtime separate from state, audit separate from writes, agent tools separate from methods) is another place where truth diverges. The common failures of a stack like that aren't bugs; they're the seams showing through.

Treenix's spine makes most of those seams structurally unavailable: one [type](./types.md) produces the schema, the form, the validation, the RPC, the MCP tool, and the audit entry. You can't have them drift because they're derived from the same declaration. Fewer seams, fewer truth races.

The trade is real: you accept one engine's opinion about how data lives. If the opinion fits, you trade surface area for integrity.

## Break early

Early stage is the time to break things. Later, every signature change is a migration across a hundred files. Now it's five. If you see a bent abstraction, three different signatures for the same operation, positional arguments that keep growing — **break it now.** The cost of fixing only grows. Don't hide technical debt behind "but it works."

Classes are allowed where they *describe the shape of typed data* — [Type](./types.md) definitions, schema, validation. Everywhere else: plain objects and functions.

Complexity is the enemy. Simplicity isn't a lack of features; it's a discipline.

## Related

- [Overview](./overview.md) — the three-primitive spine in one read
- [Composition](./composition.md) — why Component / Node / Forest covers the ground
- [The Tree](./tree.md) — the five-method data interface
- [Roadmap](./roadmap.md) — what's new that these principles had to admit
