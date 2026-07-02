## branch

Write-isolated futures over the live tree. Overlay mechanics live in
`@treenx/core/tree/branch` (Layer 1); this mod owns types, mount adapter,
lifecycle. Design: `core` repo `docs/engine/branches-plan.md`, epic core-wm6.

### Files
- **types.ts** — `t.branches` (container, `create`), `t.branch` (`diff`, `requestMerge`,
  `merge`, `abandon`). ISOMORPHIC (client convention entry) — no server imports;
  security/* pulls node:crypto and kills the whole mod in the browser bundle
- **service.ts** — server only: `t.mount.branch` adapter, `/.branch` control window,
  `branchScope`
- **approvals.ts** — `fileMergeApprovals(store)`: status=review → ai.approval inbox entry
  (projection, filed by the orchestrator watcher; requestMerge only flips status)
- **seed.ts** — `/branches` root + `#description` (t.description — THE agent onboarding
  text; prompt composers inject it, ad-hoc agents read it via MCP; edit live, no deploy)
- **view.tsx** — react diff view (red/green per entry, lifecycle buttons)
- **schemas/** — generated, never hand-edit (`npm run schema`)

### Structure per branch
```
/branches/<id>         t.branch  (base, owner, status, conflicts[])
/branches/<id>/delta   wrapper nodes: t.branch.delta {baseRev, node} | t.branch.whiteout
/branches/<id>/tree    mounted merged view — work happens here
```

### Control plane vs data plane
The overlay captures ALL writes — so branch lifecycle must escape it. `/.branch`
(Plan9 /proc/self) proxies reads/writes to the REAL t.branch node; lifecycle
actions through it use `realBranchPath()` to find delta/live. Branch-rooted MCP
sessions (`session.branch` → '/' re-rooted to `<branch>/tree`) get `/.branch`
executes re-targeted by the MCP layer to the real node on the non-rooted store —
the delta is unreachable from view coordinates by design. Never expose the
branch node as overlay DATA inside the view: nested tree addressing aliases
delta paths, and control writes would sink into the branch's own delta.

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
