## audit

Append-only `audit.event` journal for every mutation. **Wrapper, not subscriber:**
audit append happens in the same pipeline tick as the write — if the audit
backend fails, the original mutation also fails (loud).

### Files
- **with-audit.ts** — `withAudit(tree)` wrapper + `auditExecHooks(tree)` delegation hooks (core-pa3m)
- **with-audit.test.ts** — set / remove / patch / recursion guard / loud-fail / delegation rows
- **health.ts** — `markUnhealthy / isHealthy / unhealthyReason / resetHealthForTest`
- **health.test.ts** — flag transitions + recovery-probe behaviour

### Event shape
Each mutation produces a node at `/sys/audit/event/<ts>-<rand>`:
```ts
{
  $type: 'audit.event',
  ts, op: 'set'|'remove'|'patch', path,
  before: NodeData | null,
  after:  NodeData | null,
  ops?: PatchOp[],          // patch only
  by?, onBehalfOf?, taskPath?, runPath?, action?, requestId?,   // from ctx.actor
}
```

`ctx.actor` is stamped by `withAcl` on every mutation it forwards (core-3j54) —
direct verbs (tRPC/TWP set/patch/rm, setComponent, deployPrefab, MCP set_node)
land attributed as the session user without caller-threaded ctx. A caller-supplied
actor (executor: action/requestId, workload: taskPath/runPath/onBehalfOf) wins over
the default stamp. Writes below the ACL boundary (services, systemTree) carry no
actor unless the caller threads one.

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

### Health flag (auto-heal, core-98jr)
Flips to unhealthy on audit append failure; server middleware returns 503 on
all non-`/health` endpoints while unhealthy (throttled reject log — the gate
never rejects silently). Heals two ways: any successful append calls
`markHealthy()`, and while unhealthy `checkHealth()` (wired as the HTTP gate)
runs a throttled REAL append probe — the probe row lands in the journal and
documents the recovery. `resetHealthForTest()` is for unit tests only.

### Delegated executes (core-pa3m)
A delegated `Tree.execute` (core-pxlu federation) commits on the REMOTE side — the
local write path never runs, so the mutation wrapper sees nothing. `auditExecHooks(tree)`
journals the local user→action link instead: `op: 'delegate'` (intent, appended BEFORE
the remote call; append failure rejects → withExecute aborts the delegation, fail closed)
and `op: 'delegate-settled'` (`ok`, `error?`; append failure marks unhealthy, result still
returned — a remote commit cannot be rolled back). Rows carry `path`, `action`, `by`
(userId), `requestId` (opId); `before`/`after` are null (images live on the remote authority).

### Wiring (done)
- `engine/mods/audit/seed.ts` — `/sys/audit/event` mount-point (Mongo `audit_events`)
- `engine/core/src/server/main.ts` — `wrapTree = withAudit` + `execHooks = auditExecHooks` gated on `'audit' ∈ seeds`
- `engine/core/src/server/factory.ts` — passes `config.wrapTree` + `config.execHooks` into `createPipeline`
- `engine/core/src/server/server.ts` — 503 middleware reading `isHealthy()`; `createPipeline` merges execHooks into the Tree.execute wiring

**Where the wrap goes is load-bearing.** `withAudit` is applied INSIDE
`createPipeline`, above subscriptions but BEFORE the tRPC router is built, so the
router and every per-user `withAcl` wrap the audited tree. Applying it later (after
the router) leaves tRPC writes — the primary client path — un-audited (regression
core-dpp). This requires `withAudit` to forward `scanChildren`/`watch` (it does, via
`...tree` spread) so the audited tree stays a valid read-runtime source. Boot writes
(seed/log/autostart) go through `pipeline.systemTree` (mountable, below the wrap) and
are intentionally NOT audited — otherwise startup would storm the journal.
