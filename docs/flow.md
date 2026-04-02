# Flow — Visual Workflow Engine

Flow is the declarative wiring layer for Treenity. It replaces invisible `ctx.subscribe()` calls in service.ts with observable, editable workflow nodes in the tree.

## Architecture

```
flow.scenario (node)        — workflow graph: edges[], variables[], status, result, log
  flow.node.start           — entry point, declares output vars from input
  flow.node.end             — exit point, maps vars to output
  flow.node.code            — QuickJS WASM sandbox, runs JS safely
  flow.node.condition       — boolean expression → branches (true/false ports)
  flow.node.loop            — iterates collection, runs subgraph per item
  flow.node.action          — calls executeAction on another tree node (cross-mod bridge)
  flow.node.llm             — LLM call (Anthropic/OpenAI)
  flow.node.http            — HTTP request

flow.trigger (component)    — reactive trigger on a scenario node
  mode: watch | schedule
  watch: path + filter → fires scenario on tree changes
  schedule: interval → fires periodically
```

## How it works

1. **Scenario** = directed acyclic graph of nodes connected by edges
2. **Execution**: topological sort → sequential run → condition nodes deactivate dead branches
3. **Variables**: shared `Map<string, unknown>` — each node reads/writes vars
4. **Sandbox**: code/condition nodes run in QuickJS WASM — no host access, memory/time limits
5. **Actions**: `action:run` executes the flow, writes status/result/log back to the scenario node via Immer
6. **Triggers**: service watches tree paths, fires `action:run` when filter matches

## Variable access in sandbox

Code nodes receive variables via `ctx` object (plain object, not Map):

```js
// ✅ Correct — ctx.{varName} or ctx.vars.{varName}
return `Hello, ${ctx.name}!`
const n = ctx.node
return ctx.vars.someVar

// ❌ Wrong — vars is not a Map in sandbox
vars.get("name")  // TypeError: vars.get is not a function
```

Condition expressions get vars destructured as bare names:

```js
// In condition node — bare variable access
age >= 18          // ✅ works
items.length > 0   // ✅ works
```

## Cross-mod wiring via flow.node.action

The action node bridges flows to any registered Treenity action:

```
targetPath:    "/counter"           — supports {{var}} interpolation
targetType:    "test.counter"       — type for action resolution
targetAction:  "setLabel"           — action name
dataTemplate:  '{"label": "{{msg}}"}'  — JSON with {{var}} interpolation
```

This replaces hardcoded `ctx.subscribe()` + `tree.set()` in services:

| Before (service.ts) | After (flow) |
|---|---|
| `ctx.subscribe('/inbox', (e) => tree.set(...))` | `flow.trigger` watching `/inbox` → `flow.node.action` |
| Invisible, buried in code | Visible node in tree, editable via UI or MCP |
| No logging, no status | `status`, `result`, `log`, `lastRun` on scenario |

## Triggers

Add a `trigger` component to a scenario node:

```ts
{
  $type: 'flow.trigger',
  mode: 'watch',
  watchPath: '/data/inbox',
  watchChildren: true,        // watch /data/inbox/**
  filter: '{"status":"new"}', // JSON filter — all keys must match
  interval: 0,
  enabled: true,
}
```

When a node under `/data/inbox` changes and matches the filter, the scenario runs with `{ event, node }` as input.

## Actions

| Action | Description |
|---|---|
| `run` | Execute the flow. Input = vars for start node. Returns `{ status, result, events }` |
| `validate` | Check graph integrity: start/end nodes, dangling edges, handler availability |

## File map

```
mods/flow/
  types.ts          — FlowScenario, FlowNode*, FlowTrigger classes (registerType)
  actions.ts        — action:run (execute + persist), action:validate
  engine.ts         — executeFlow generator, topoSort, interpolate, dead-edge pruning
  service.ts        — trigger service: watch/schedule → executeAction
  handlers/
    index.ts        — handler registry
    code.ts         — QuickJS sandbox eval
    condition.ts    — boolean expression eval
    action.ts       — cross-mod action bridge (interpolate + executeAction)
    http.ts         — fetch wrapper
    llm.ts          — LLM API call
    loop.ts         — collection iteration
  sandbox-eval.ts   — evalCode/evalCondition/evalCollection via QuickJS
  seed.ts           — demo "greeting pipeline" scenario
  schemas/          — JSON schemas per type (loaded at boot)
  views/
    editor.tsx      — visual flow editor
    node-renderers.tsx — per-type node rendering
    run-panel.tsx   — execution panel
  e2e.test.ts       — integration tests (11 tests, real tree + pipeline)
  engine.test.ts    — unit tests for engine/topoSort
  sandbox-eval.test.ts — sandbox security tests
```

## Testing

```bash
# Run flow e2e tests
npx tsx --conditions development --test mods/flow/e2e.test.ts

# Run all flow tests
npx tsx --conditions development --test 'mods/flow/**/*.test.ts'
```

The e2e tests create a real `createPipeline` (mounts → validation → subscriptions), set up scenarios with child nodes, execute via `executeAction`, and verify both the return value and persisted state.

### What's tested (e2e.test.ts)

- **Linear pipeline**: start → code → end, verify result + persisted status/log
- **Condition branching**: true/false paths with expression eval
- **Error handling**: code node throws → status=error, no validation crash
- **Validate action**: correct graph, missing start, dangling edges
- **Cross-mod action**: flow.node.action calls setLabel on another node
- **Interpolated paths**: `{{target}}` in targetPath resolves at runtime
- **Trigger watch**: service subscribes, fires on change, updates trigger stats
- **Trigger filter**: only fires when changed node matches JSON filter
- **Full pipeline**: data arrives → code extracts → action mutates another mod
