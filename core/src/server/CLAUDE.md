## server
HTTP сервер + tRPC + auth + mount system + store pipeline

### Файлы
- index.ts — bootstrap: overlay(base,work) → mount → volatile → validate → subscriptions
- trpc.ts — tRPC router, Immer drafts in execute, OCC→CONFLICT mapping
- auth.ts — ACL, sessions, withAcl wrapper, buildClaims
- mount.ts — withMounts walks path, resolves monts
- mount-adapters.ts — t.mount.mongo/fs/memory/overlay/types/query (MountAdapter)
- types-mount.ts — createTypesStore: /sys/types virtual tree from all registered types
- validate.ts — Write-Barrier: schema validation before tree.set()
- volatile.ts — in-memory overlay for volatile components
- watch.ts — watchChildren, prefix watch, notify
- sub.ts — withSubscriptions wrapper, NodeEvent emit
- actions.ts — executeAction(tree,path,type?,key?,action,data?), createNodeHandle, serverNodeHandle; callAction deleted
- seed/ — initial tree: core.ts + domain module seeds
- mcp.ts — MCP server: get_node, list_children, set_node, remove_node, execute

### Конвенции
- Tree pipeline: withMounts → volatile → validated → subscriptions
- Mount = component on node, adapter via resolve($type, "mount")
- ACL: GroupPerm[], p>0 allow, p=0 deny all sticky, p<0 deny bits sticky
- Sealed registry: register() throws on duplicate (no overrides)
- types-mount: getRegisteredTypes() — all types in /sys/types, not just schema-registered
- executeAction: type=$type for scan/verify, key=field name; no patches → skip persist
- trpc execute: {path, type?, key?, action, data?, watch?} — NO component field (deleted)
