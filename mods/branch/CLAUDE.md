## branch

Write-isolated futures over the live tree. Overlay mechanics live in
`@treenx/core/tree/branch` (Layer 1); this mod owns types, mount adapter,
lifecycle. Design: `core` repo `docs/engine/branches-plan.md`, epic core-wm6.

### Files
- **types.ts** — `t.branches` (container, `create`), `t.branch` (`diff`, `abandon`;
  merge/requestMerge come with core-wm6.3), `t.mount.branch` adapter
- **seed.ts** — `/branches` root (admins + agents RWAS; per-branch nodes add `u:<owner>`)
- **schemas/** — generated, never hand-edit (`npm run schema`)

### Structure per branch
```
/branches/<id>         t.branch  (base, owner, status, conflicts[])
/branches/<id>/delta   wrapper nodes: t.branch.delta {baseRev, node} | t.branch.whiteout
/branches/<id>/tree    mounted merged view — work happens here
```

### Load-bearing invariants
- **Owner-projected lower**: the view reads live as `withAcl(store, owner)` —
  mount adapters are caller-blind and outer ACL checks only view paths; without
  projection a branch reads live paths its owner cannot see.
- **Lower is read-only** (`wrapReadOnlyTree`) and **denies `/branches`**
  (recursion + cross-branch privacy; namespace shaping at a trust boundary).
- **AclStore has no scanChildren** — adapter composes one via `createProjector`
  (same per-node projection executeList uses). Remove when read-runtime ships it.
- Writes through the view pass the OUTER pipeline at view paths (validated,
  audited, subscribed); the inner delta write bypasses it by design — read delta
  via `scanChildren` only (withCache serves scans fresh from storage).
