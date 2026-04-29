---
title: Create a Mod
section: guides
order: 1
description: Full mod lifecycle — types, actions, views, services, seed data, testing
tags: [guide, intermediate]
---

# Create a Mod

A mod is a self-contained package of types, actions, views, and services. This guide walks through building one from scratch — with patterns you'll use in every Treenix project.

## Structure

```
mods/mymod/
  types.ts            type classes + registerType()
  view.tsx            React views
  service.ts          background workers (optional)
  seed.ts             initial data (optional)
  schemas/            generated JSON Schemas
  mymod.test.ts       tests
```

### Discovery

Local mods are discovered by convention. On server startup Treenix imports `types.ts`, `seed.ts`, and `service.ts` if they exist. In the frontend, the Vite plugin imports `types.ts` and `view.tsx`.

If a mod needs custom ordering, add explicit entry files:

```typescript
// server.ts
import './types'
import './service'
import './seed'

// client.ts
import './types'
import './view'
```

When `server.ts` exists, the server imports it instead of the convention files. When `client.ts` exists, the frontend imports it instead of the convention files.

Server changes require a restart. Client changes hot-reload via Vite.

## Types

Define your data and behavior in a single class:

```typescript
// types.ts
import { getCtx, registerType } from '@treenx/core/comp'

export class SensorConfig {
  /** @title Interval @description Seconds between readings */
  interval = 5
  /** @title Source */
  source = ''

  updateInterval(data: { interval: number }) {
    this.interval = data.interval
  }

  async history() {
    const { node, tree } = getCtx()
    const { items } = await tree.getChildren(node.$path, { limit: 100 })
    return items
  }
}

registerType('sensor.config', SensorConfig)

export class SensorReading {
  value = 0
  ts = 0
}

registerType('sensor.reading', SensorReading)
```

Schemas auto-generate into `schemas/` on dev server startup.

## Views

Register React views for each context you need:

```typescript
// view.tsx
import { register } from '@treenx/core'
import type { View } from '@treenx/react/context'
import { usePath, useChildren } from '@treenx/react/hooks'
import { SensorConfig } from './types'

const SensorView: View<SensorConfig> = ({ value, ctx }) => {
  const { data: sensor } = usePath(ctx!.node.$path, SensorConfig)
  const { data: readings } = useChildren(ctx!.node.$path, { limit: 20, watchNew: true })

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-bold">Sensor: {ctx!.node.$path}</h3>
        <span className="text-sm text-muted-foreground">
          every {sensor.interval}s
        </span>
      </div>

      <div className="space-y-1">
        {readings.map(r => (
          <div key={r.$path} className="text-sm font-mono">
            {(r as SensorReading).value?.toFixed(1)}
          </div>
        ))}
      </div>
    </div>
  )
}

register(SensorConfig, 'react', SensorView)
```

**Patterns:**
- Always use `View<T>` — never `{ value: any }`
- `usePath(path, Class)` gives you a reactive TypeProxy with typed methods
- `useChildren` with `watchNew: true` auto-updates when new children appear
- Render children through `<Render>` and `<RenderContext>`, not hardcoded components
- Tailwind classes only — never inline styles

## Services

Background workers run as long as their node exists in the tree:

```typescript
// service.ts
import { createNode, getComponent } from '@treenx/core'
import { register } from '@treenx/core'
import type { ServiceHandle } from '@treenx/core/contexts/service'
import { SensorConfig } from './types'

register('sensor', 'service', async (node, ctx) => {
  const config = getComponent(node, SensorConfig)
  const interval = (config?.interval ?? 5) * 1000

  const timer = setInterval(async () => {
    await ctx.tree.set(createNode(
      `${node.$path}/${Date.now()}`,
      'sensor.reading',
      { value: Math.random() * 100, ts: Date.now() },
    ))
  }, interval)

  return {
    stop: async () => clearInterval(timer),
  } satisfies ServiceHandle
})
```

### Autostart

To start a service automatically when the server boots, add a ref to `/sys/autostart`:

```typescript
await tree.set(createNode('/sys/autostart/my-sensor', 'ref', {
  $ref: '/sensors/temp',
}))
```

The server walks `/sys/autostart` at startup, resolves refs, and starts service handlers.

## Seed Data

`registerPrefab` with name `'seed'` deploys data on startup when the mod is included by the root seed filter:

```typescript
// seed.ts
import type { NodeData } from '@treenx/core'
import { registerPrefab } from '@treenx/core/mod'

registerPrefab('sensor-demo', 'seed', [
  { $path: 'sensors', $type: 'dir' },
  {
    $path: 'sensors/temp',
    $type: 'sensor',
    config: { $type: 'sensor.config', interval: 10, source: 'internal' },
  },
  {
    $path: 'sys/autostart/temp-sensor',
    $type: 'ref',
    $ref: '/sensors/temp',
  },
] as NodeData[])
```

If `root.json` has a `seeds` array, add the mod name there:

```json
{
  "seeds": ["core", "sensor-demo"]
}
```

Prefabs with other names are deployed on demand via `deploy_prefab` MCP tool.

## Testing

Use `node:test` and test against contracts, not implementation details:

```typescript
// mymod.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNode, getComponent } from '@treenx/core'
import { getDefaults } from '@treenx/core/comp'
import { SensorConfig } from './types'

describe('SensorConfig', () => {
  it('creates node with provided data', () => {
    const node = createNode('/s', SensorConfig, { interval: 30, source: 'api' })
    const config = getComponent(node, SensorConfig)!
    assert.equal(config.interval, 30)
    assert.equal(config.source, 'api')
  })

  it('getDefaults returns class field defaults', () => {
    const defaults = getDefaults(SensorConfig)
    assert.equal(defaults.interval, 5)
    assert.equal(defaults.source, '')
  })
})
```

Run tests:

```bash
npm test
```

**Testing rules:**
- Assert contracts (return shapes, error codes), never error message strings
- Use `assert.rejects(fn, predicate)`, not try/catch
- Every `it()` must have at least one assertion
- Bug fix → write a regression test for the exact broken scenario

## Publishing as npm

To share a mod:

1. Set up `package.json` with the `treenix` field:

```json
{
  "name": "treenix-mod-sensor",
  "treenix": {
    "name": "sensor",
    "types": ["sensor.config", "sensor.reading"],
    "servers": "./dist/server.js",
    "clients": "./dist/client.js"
  },
  "peerDependencies": {
    "@treenx/core": "^3.0.0"
  }
}
```

2. Build and publish:

```bash
npm publish
```

The `treenix` field enables automatic discovery. When someone installs your package, `discoverMods()` finds it by scanning `node_modules` for packages with this field.

## Checklist

1. Define types in `types.ts` + `registerType()`
2. Write tests → `npm test` → green
3. Schemas auto-generate into `schemas/` on dev server startup
4. Write views in `view.tsx` + `register(type, 'react', View)`
5. Check browser console → zero errors
6. Add seed data if needed
7. Commit (one logical change per commit)

## Related

- [Tutorial](../getting-started/tutorial.md) — beginner walkthrough
- [Concepts: Types](../concepts/types.md) — registerType, JSDoc, naming
- [Guide: React Views](react-views.md) — advanced view patterns
