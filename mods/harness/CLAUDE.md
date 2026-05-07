## harness

Composable scope for **workload identities** (short-lived agents, automation).
Sits between ACL and `executeAction` — narrows what an already-authenticated
caller can read, write, and invoke.

### Files
- **capability.ts** — `Capability`, `withCapability(tree, cap)`, `executeWithCapability`, `AgentScope`, `defineAgentScope`
- **capability.test.ts** — read/write/empty cases
- **execute.test.ts** — exec whitelist, target-path check, confused-deputy guard
- **scope.test.ts** — DX wrapper

### Concepts

**`Capability`** — three lists, all globs, all empty = deny:
```ts
{ readPaths: string[], writePaths: string[], allowedExec: string[] }
```

**`withCapability(tree, cap)`** — Tree wrapper. Stack on top of `withAcl(...)`.
Filters every `get/getChildren/set/remove/patch` by paths. Fail-closed: missing
or empty list = deny that op.

**`executeWithCapability(tree, cap, input, actor)`** — entry helper for MCP/tRPC
when the caller is a workload. Three checks before delegating to `executeAction`:
1. `input.action ∈ cap.allowedExec`
2. `input.path ∈ cap.writePaths`
3. tree handed to handler is `withCapability(tree, cap)` so internal `ctx.tree`
   writes also stay in scope (closes confused-deputy hole).

**`defineAgentScope({ plan, work })`** — DX helper for mod authors. Maps
short `{ read, write, exec }` keys to internal `Capability`. Stamped
`$type: 'agent.scope'` so it's a valid named-component on an agent-port node.

### Conventions
- Capabilities are **declarative** — author writes them at seed time as a named
  component on the agent-port node, not at run time.
- `plan` mode is the read-only-ish baseline; `work` mode is the broader scope
  granted after the human approves the plan via `approvePlan`.
- The platform entry point (MCP/tRPC) is responsible for picking `plan` vs
  `work` based on the run state, then calling `executeWithCapability`.
- Action handlers themselves never see the raw tree — always the wrapped one.
