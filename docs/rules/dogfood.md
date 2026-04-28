# Dogfood: Build Treenix WITH Treenix

## Principle

Data that benefits from addressability, ACL, subscriptions, or AI visibility — must be a node.
Transport, build tooling, runtime plumbing — stay outside the tree.

The question is not "can this be a node?" but **"does this gain something by being a node?"**
If it gains addressability, permissions, reactivity, or AI access — dogfood it.
If it's just a pipe or a build artifact — leave it as infrastructure.

## The boundary

**Dogfood (data/state/config):**
- Service config → node (schema-validated, ACL-protected, AI-visible)
- Service status → node (subscribe to `/proc/bot`, same UI as everything else)
- Task queue → ref-queue dir (spatial state machine, watchers react to moves)
- Type definitions → mounted at `/types` (already done)
- Startup order → `/autostart` dir with refs (already done)

**Don't dogfood (plumbing/transport):**
- WebSocket connection to an exchange — it's a pipe, not an entity
- tRPC router definition — it's code structure
- Vite/build config — build-time, not runtime
- package.json, tsconfig — tooling
- .env secrets — security boundary, never in tree

## Why dogfood what we can

- Side-channels bypass ACL, subscriptions, mounts, MCP
- Hardcoded lists are invisible to AI agents living in the tree
- If the platform can't host its own config, it's not a platform yet
- Every node in the tree is automatically: addressable, watchable, permissioned, AI-accessible

## Already dogfooded

| Subsystem | How |
|-----------|-----|
| Service startup | `/autostart` dir + ref children → init.d as nodes |
| Type library | `/types` mount → schemas are nodes with contexts |
| Mount routing | `mount-point` component on dir nodes |
| Query filters | `t.mount.query` nodes with sift config as data |
| AI agents | Sim entities live as nodes, observe tree, call actions |
| MCP access | Tree operations exposed as tools — AI lives inside |

## Candidates for dogfooding

| Subsystem | Instead of | As tree |
|-----------|-----------|---------|
| Running services | opaque process state | `/proc/{name}` nodes with status/uptime/errors |
| System services | hardcoded paths | `/sys/auth`, `/sys/types` convention |
| App config | .env values (non-secret) | Config nodes with schema validation |
| Monitoring | external dashboards | Subscribe to `/proc` — same UI, same ACL |
| Task queues | external queue service | Ref-queue dirs (`/queues/kitchen/new/`) |

## Standards beat dogfood

Dogfood is a tool, not a religion. When an industry standard exists — **use it**.

**Don't reinvent:**
- Package management → npm/bun workspaces, Cargo.toml, go.mod. Not "mod dependency nodes"
- Dependency resolution → existing resolvers (bun, cargo, go). Not a custom resolver in the tree
- Build tooling → vite, tsc, esbuild. Not "build-as-nodes"
- Version control → git. Not "version history as tree nodes"
- CI/CD → GitHub Actions, scripts. Not "pipeline nodes"

**Do dogfood:**
- Data that's unique to YOUR domain and has no standard format
- Config that benefits from ACL, AI visibility, reactivity
- State that users/agents need to observe and act on

**The rule:** If a well-adopted standard solves the problem — adopt it. Dogfood only what standards can't cover. Wrapping `package.json` in a node adds complexity without value. Writing mod dependency manifests as nodes adds value because no standard describes cross-ecosystem Treenix mod dependencies.

**Package Calculus example:** npm resolves JS deps. Cargo resolves Rust deps. But nobody resolves deps *between* a JS mod and a Rust WASM mod in Treenix's context. THAT gap is where dogfood adds value — `t.mod` manifests bridge what standards can't.

## Quick test

Before adding a new subsystem, ask:

1. **Is there a standard for this?** Yes → use it. Don't dogfood what's already solved.
2. **Is this data or plumbing?** Data → dogfood. Plumbing → don't.
3. **Would AI benefit from seeing it?** Yes → must be a node.
4. **Does it need permissions?** Yes → must be a node.
5. **Does it need reactivity?** Yes → should be a node.

All NO → it's infrastructure. Use the right tool for the job.
