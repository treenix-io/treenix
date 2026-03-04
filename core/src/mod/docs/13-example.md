# 13 — Полный пример: мод от начала до конца

## 1. types.ts — определение компонентов

```ts
// src/mods/sensor/types.ts
import { getCtx, registerComp } from '#comp';
import { join, type NodeData } from '#core';

export class SensorConfig {
  /** @title Интервал @description Секунды между замерами */
  interval = 5;
  /** @title Источник */
  source = '';

  updateInterval(data: { interval: number }) {
    this.interval = data.interval;
  }

  async history() {
    const { node, store } = getCtx();
    const { items } = await store.getChildren(node.$path, { limit: 100 });
    return { items: items.map(n => ({ value: (n as any).value, ts: (n as any).ts })) };
  }
}

registerComp('sensor.config', SensorConfig);

export class SensorReading {
  value = 0;
  ts = 0;
}

registerComp('sensor.reading', SensorReading);
```

## 2. service.ts — фоновый процесс

```ts
// src/mods/sensor/service.ts
import { register, type NodeData } from '#core';
import { getComp } from '#comp';
import { type ServiceHandle, type ServiceCtx } from '#contexts/service';
import { SensorConfig } from './types';

register('sensor', 'service', async (node: NodeData, ctx: ServiceCtx) => {
  const config = getComp(node, SensorConfig);
  const interval = (config?.interval ?? 5) * 1000;

  const timer = setInterval(async () => {
    await ctx.store.set({
      $path: `${node.$path}/${Date.now()}`,
      $type: 'sensor.reading',
      value: Math.random() * 100,
      ts: Date.now(),
    } as NodeData);
  }, interval);

  return { stop: async () => clearInterval(timer) } satisfies ServiceHandle;
});
```

## 3. view.tsx — React-рендер

```tsx
// src/mods/sensor/view.tsx
import { register, type ComponentData } from '#core';
import { useCurrentNode } from '#contexts/react';
import { useChildren } from '#front/hooks';

register('sensor.config', 'react', ({ value, onChange }) => {
  return (
    <div>
      <label>Interval: {(value as any).interval}s</label>
      <label>Source: {(value as any).source}</label>
    </div>
  );
});

register('sensor', 'react', ({ value }) => {
  const node = useCurrentNode();
  const readings = useChildren(node.$path, { limit: 10, watchNew: true });

  return (
    <div>
      <h3>Sensor: {node.$path}</h3>
      {readings.map(r => (
        <div key={r.$path}>
          {(r as any).value?.toFixed(1)} @ {new Date((r as any).ts).toLocaleTimeString()}
        </div>
      ))}
    </div>
  );
});
```

## 4. schemas.ts — JSON Schema

```ts
// src/mods/sensor/schemas.ts
import { register } from '#core';

register('sensor.config', 'schema', () => ({
  title: 'Sensor Config',
  properties: {
    interval: { type: 'number', title: 'Interval (sec)', minimum: 1 },
    source: { type: 'string', title: 'Source URL' },
  },
}));
```

## 5. Регистрация

```ts
// src/mods/index.ts — добавить:
import './sensor/types';
import './sensor/service';

// src/mods/views.ts — добавить:
import './sensor/view';
import './sensor/schemas';
```

## 6. Seed-данные

```ts
await store.set({ $path: '/sensors/temp', $type: 'sensor',
  config: { $type: 'sensor.config', interval: 10, source: 'internal' },
} as NodeData);

await store.set({ $path: '/sys/autostart/temp-sensor', $type: 'ref', $ref: '/sensors/temp' } as NodeData);
```
