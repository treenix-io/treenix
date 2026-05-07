## audit

Append-only `audit.event` journal for every mutation. **Wrapper, not subscriber:**
audit append happens in the same pipeline tick as the write — if the audit
backend fails, the original mutation also fails (loud).

### Files
- **with-audit.ts** — `withAudit(tree)` wrapper
- **with-audit.test.ts** — set / remove / patch / recursion guard / loud-fail
- **health.ts** — `markUnhealthy / isHealthy / unhealthyReason / resetHealthForTest`
- **health.test.ts** — sticky flag behaviour

### Event shape
Each mutation produces a node at `/sys/audit/event/<ts>-<rand>`:
```ts
{
  $type: 'audit.event',
  ts, op: 'set'|'remove'|'patch', path,
  before: NodeData | null,
  after:  NodeData | null,
  ops?: PatchOp[],          // patch only
  by?, taskPath?, runPath?, action?, requestId?,   // from ctx.actor
}
```

### Why a wrapper, not a CDC subscriber
`withSubscriptions.emit` runs listeners **after** `tree.set` commits. A failing
subscriber leaves a committed mutation without an audit row — the exact failure
mode this layer must close. The wrapper performs:
1. read before-image
2. write
3. append `audit.event`
4. on append failure → `markUnhealthy()` + rethrow

Not transactional against process crash (Phase 0 trade-off), but the
"audit-backend-down → silent loss" path is closed.

### Recursion guard
Direct writes to `/sys/audit/event/*` pass through untouched. Without this the
audit append would itself trigger another audit append, ad infinitum.

### Health flag (sticky)
Once flipped to unhealthy by an audit failure, stays until process restart.
Server middleware should return 503 on all non-`/health` endpoints while
unhealthy. `resetHealthForTest()` is for unit tests only.

### Wiring (TODO — not yet done)
- `engine/mods/audit/seed.ts` — declare `/sys/audit/event` mount-point
- `engine/core/src/server/factory.ts` — `wrapTree?: (tree) => tree` extension
- `engine/core/src/server/server.ts` — 503 middleware reading `isHealthy()`
