# @treenx/agent-client

TOFU (Trust On First Use) client for connecting agents to a Treenix server.

## Install

```bash
npm install @treenx/agent-client
# or link from monorepo
npm link @treenx/core @treenx/agent-client
```

## Usage

```ts
import { createAgentClient, createNodeClient } from '@treenx/agent-client'
import { BotConfig } from './types' // your type class

const agent = createAgentClient({
  url: 'http://localhost:3211',
  path: '/agents/my-bot',
  key: 'my-secret-key',
})

const client = await agent.waitForApproval()
const nc = createNodeClient(client)

// Typed actions — like serverNodeHandle, no fetch needed
await nc('config').get(BotConfig).updateSettings({ interval: 5000 })

// Fetch typed data + actions
const cfg = await nc('config').fetch(BotConfig)
console.log(cfg.apiKey)              // typed field
await cfg.updateSettings({ x: 1 })   // typed action

// Reactive subscription — callback on every change
const { unsubscribe } = await nc('signals').sub(SignalData, (data) => {
  console.log(data.price, data.volume) // typed, always latest
})

// Low-level: raw tree access (relative paths)
await client.tree.set({ $path: 'status', $type: 'bot.status', online: true })
const raw = await client.tree.get('config')
```

## How it works

1. **Admin** creates an agent port node on the server (`$type: 't.agent.port'`)
2. **Agent** calls `connect()` with its secret key
3. **First connect** — key goes to "pending" (TOFU). Agent is not yet authorized
4. **Admin** approves — key is locked, agent user is created with `agent` group
5. **Agent** calls `connect()` again — gets a session token
6. **Agent** reads/writes within its subtree using relative paths

## Relative paths

All paths are scoped to the agent's subtree automatically:

| You write | Resolves to |
|-----------|-------------|
| `"status"` | `/agents/my-bot/status` |
| `"trades/latest"` | `/agents/my-bot/trades/latest` |
| `"./config"` | `/agents/my-bot/config` |
| `""` or `"."` | `/agents/my-bot` |
| `"/absolute"` | `/absolute` (escape hatch) |

## API

### `createAgentClient(opts)`

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | Treenix server URL |
| `path` | `string` | Agent port node path |
| `key` | `string` | Secret key |

Returns `{ connect, waitForApproval }`.

### `connect(): Promise<ConnectResult>`

Single attempt:
- `{ status: 'pending' }` — waiting for admin approval
- `{ status: 'approved', client, token, userId }` — ready

### `waitForApproval(opts?): Promise<TreenixClient>`

Polls until approved.

| Option | Default | Description |
|--------|---------|-------------|
| `interval` | `5000` | Poll interval (ms) |
| `timeout` | `300000` | Total timeout (ms) |

## Typed node access — `createNodeClient`

`createNodeClient(client)` returns `nc` — a typed node handle factory. Same pattern as `serverNodeHandle` but over the network.

```ts
const nc = createNodeClient(client)
```

### `nc(path).get(Class)` — actions proxy

No fetch needed. Methods call `execute()` over tRPC.

```ts
await nc('config').get(BotConfig).updateSettings({ interval: 5000 })
await nc('tasks/1').get(Task).complete({ result: 'done' })
```

### `nc(path).fetch(Class)` — data + actions

Fetches the node, returns typed proxy with both data fields and action methods.

```ts
const cfg = await nc('config').fetch(BotConfig)
cfg.apiKey     // string — typed field from fetched node
cfg.interval   // number
await cfg.updateSettings({ interval: 10000 }) // typed action
```

### `nc(path).sub(Class, callback)` — reactive subscription

Registers SSE watch, calls back with typed proxy on every change. Multiple subs share one SSE connection.

```ts
const { unsubscribe } = await nc('signals').sub(SignalData, (data) => {
  console.log(data.price, data.volume) // typed, always latest
})
```

### Low-level: `client.watchPath(path, callback)`

Raw event subscription. Use when you need event type (set/patch/remove) or don't have a type class.

```ts
const { node, unsubscribe } = await client.watchPath('signals', (event) => {
  if (event.type === 'set') console.log('new data:', event.node)
  if (event.type === 'patch') console.log('patches:', event.patches)
})
```
