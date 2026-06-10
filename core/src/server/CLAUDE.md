## server
HTTP server + tRPC + store pipeline

### Files
- server.ts — HTTP wrapper and tree pipeline composition
- factory.ts — treenix() boot: load mods, build pipeline, deploy seeds, start services
- trpc.ts — tRPC router, Immer drafts in execute, OCC→CONFLICT mapping
- actions.ts — executeAction(tree,path,type?,key?,action,data?), createNodeHandle, serverNodeHandle; callAction deleted
- prefab.ts — deploy registered prefab data into a tree
- seed/ — initial tree: core.ts + domain module seeds

### Conventions
- Tree pipeline: mounts → migration → volatile → validation → ref index → cache → subscriptions (migration above mounts so fs/mongo/federation nodes migrate on read)
- Mount code lives in `core/src/mount`; tree wrappers live in `core/src/tree`; auth/ACL lives in `core/src/security`; subscriptions live in `core/src/sub`.
- ACL: GroupPerm[], p>0 allow, p=0 deny all sticky, p<0 deny bits sticky
- Sealed registry: register() keeps the first handler unless explicitly replaced
- mount/types: getRegisteredTypes() — all types in /sys/types, not just schema-registered
- executeAction: type=$type for scan/verify, key=field name; no patches → skip persist
- trpc execute: {path, type?, key?, action, data?, watch?} — NO component field (deleted)
