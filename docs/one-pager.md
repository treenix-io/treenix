# Treenity

**A spatial protocol for typed data. Three primitives. Minimal core. Everything else composes.**

## The Problem

A single business concept — say, an Order — lives in five places: database schema, ORM, API DTO, frontend state, validation rules. Each copy drifts. Each sync layer adds bugs. Meanwhile, AI agents drown in infinite code grammar with no structural guardrails.

Three prototypes tried to solve this over ten years. All died from saying YES — 40,000+ lines, six developers, zero survivors. What remained was a question: *what is the absolute minimum?*

The answer: three primitives.

## Three Primitives

**Node** — an addressable entity. `/orders/123` is both its identity and its location in the tree. Children derive from path prefix queries — not stored in the parent. No arrays, no foreign keys. Like a file in a filesystem.

**Component** — a named aspect of a node. An order has `status`, `payment`, `delivery` — each independently typed, validated by schema, and isolated. Components never see their siblings. If one needs neighbor data, it declares the dependency explicitly and the runtime injects it.

**Context** — how a type manifests depending on who's looking. Register `("order", "react", OrderCard)` — orders render in a browser. Register `("order", "telegram", orderBot)` — the same data works as a bot. Register `("order", "text", toPlainText)` — AI can read it. One node, many surfaces. Fallback is deterministic: `react:compact → react → default → error`.

```
Node      = { $path, $type, ...components }
Component = { $type, ...data }
Context   = (Type, Context) → Handler
```

These three — plus a 76-line registry that connects them — are the entire core. Everything above builds without modifying it.

## How It Composes

**Store** — four methods: `get`, `getChildren`, `set`, `remove`. Three backends (memory, filesystem, MongoDB). Composable wrappers stack like Unix pipes: overlay (layered reads), volatile (transient in-memory state), validated (schema write-barrier), subscriptions (real-time events). Pure functions returning `Store`. No inheritance, no middleware.

**Mounts** — any node can delegate its subtree to a different storage. MongoDB at `/db`, a photo folder at `/photos`, a partner's API at `/partner`. Parametrized paths (`/users/:userId/orders`) resolve dynamically. This is Plan 9 for typed, structured data.

**ACL** — bitmask permissions (Read / Write / Admin / Subscribe) inherited down the tree, applied at node and component level. Deny-is-sticky: once denied, descendants cannot re-grant. The runtime strips forbidden components from responses — the client never sees data it shouldn't.

**Actions** — class methods become typed mutation endpoints. The server runs them inside Immer drafts, generates patches, and broadcasts to subscribers. Streaming generators (`async function*`) enable long-running operations with real-time progress — no custom WebSocket protocols needed.

## The Unified Tree

URLs, filesystem paths, and Treenity paths share one structure: an address in a tree. The only differences are transport and serialization. Treenity's mount system makes the equivalence explicit:

- Mount `~/Photos` → every JPEG becomes a typed node with EXIF components
- Mount a Swagger spec → every API endpoint becomes a node with actions and request schemas
- Mount another Treenity instance → transparent cross-organization federation
- Mount MongoDB → business data lives alongside local files in one namespace

Treenity is a lens, not a container. It doesn't copy your data — it mounts it. The data stays where it is. Treenity adds: type, contexts, permissions, subscriptions, actions. A transparent layer over existing reality.

The overlay combinator makes this precise. Mount a photo folder as a read-only lower store. Add a writable upper store for metadata. The overlay merges them: files are untouched, but now every image has ACL, tags, AI-readable descriptions, and context-aware rendering. Annotate any filesystem without modifying a single byte of it.

An OpenAPI spec is already a tree: paths are nodes, operations are actions, request schemas become write-barriers. One mount adapter unlocks thousands of public APIs — zero integration code.

**You don't import data into Treenity. You mount the world into your tree.**

## AI-Native by Design

Programming languages: infinite vocabulary, infinite grammar. Treenity with a Type Library: **finite vocabulary, strict grammar**. For an LLM, this changes the task from "write code" to "assemble from typed blocks."

- Constrained type set prevents hallucination
- Typed connections — can't plug garbage into a typed input
- Tree as JSON — native LLM format
- Business templates — few-shot examples the AI can adapt

The write-barrier enforces schemas at the storage layer. If an AI produces malformed data, it gets a compiler-like error ("Missing required field 'price'") and self-corrects. The type library at `/sys/types` lets agents discover what exists before they build. MCP server gives any LLM client direct CRUD + action execution on the tree.

Prompt: *"Make a pizza delivery bot like Acme Cafe, but with delivery tracking."*
The AI doesn't write code. It takes the cafe template, adds `delivery`, `address`, `courier` node types. Assembles.

## The Numbers

| | |
|---|---|
| Core | < 500 lines, zero dependencies |
| Store layer | 502 lines — 3 backends, 3 composable wrappers |
| Server | ~2,200 lines — mounts, ACL, tRPC, MCP, subscriptions (deps: sift, immer, tRPC) |
| Frontend | ~2,900 lines — tree navigator, inspector, reactive cache |
| Module system | 546 lines — discovery, dependency sort, hot-loading |
| Tests | 1334, all passing |
| Layers | 7, each independently replaceable |

Seven layers, strict downward dependency. Core has zero awareness of storage, transport, or rendering. Any layer can be swapped without touching the others.

## Where It Stands

```
Step 0: Core — three primitives                          ✓
Step 1: Telegram bot built from tree (cafe demo)         ✓
Step 2: One business end-to-end through the tree         ← here
Step 3: Second business — extract shared domain types
Step 4: AI assembles a third from ready blocks
Step 5: Type Library + plugin marketplace
```

Each step proves the previous one. No skipping ahead.

## The Bet

Protocols outlive corporations. Email is 53 years old. HTTP is 35. Linux is 34. Treenity takes the same form: FSL-1.1-MIT license (converts to MIT after two years), protocol specification over product, local-first architecture where data stays on the user's device.

The tree has no center. Every instance is a node in a network. Mounts connect them. Each participant owns their data, their processes, their subtree. The platform amplifies users instead of extracting from them.

Three prototypes died so this one could be distilled to its essence. Minimal core. Three primitives that fit in one sentence each. Ten years of saying NO to everything that wasn't strictly necessary.

What remains is sufficient.
