# 13 — Полный пример: мод от начала до конца

## 1. types.ts — определение компонентов

```ts
// src/mods/sensor/types.ts
import { getCtx, registerComp, getComp } from '#comp';

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
    return { items: items.map(n => {
      const r = getComp(n, SensorReading);
      return r ? { value: r.value, ts: r.ts } : null;
    }).filter(Boolean) };
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
import { register, createNode, type NodeData } from '#core';
import { getComp } from '#comp';
import { type ServiceHandle, type ServiceCtx } from '#contexts/service';
import { SensorConfig } from './types';

register('sensor', 'service', async (node: NodeData, ctx: ServiceCtx) => {
  const config = getComp(node, SensorConfig);
  const interval = (config?.interval ?? 5) * 1000;

  const timer = setInterval(async () => {
    await ctx.store.set(createNode(
      `${node.$path}/${Date.now()}`,
      'sensor.reading',
      { value: Math.random() * 100, ts: Date.now() },
    ));
  }, interval);

  return { stop: async () => clearInterval(timer) } satisfies ServiceHandle;
});
```

## 3. view.tsx — React-рендер

```tsx
// src/mods/sensor/view.tsx
import { register } from '#core';
import type { View } from '@treenity/react/context';
import { useChildren } from '@treenity/react/hooks';
import { SensorConfig, SensorReading } from './types';

// View<T> — типизированный компонент. value: T, ctx: ViewCtx
const ConfigView: View<SensorConfig> = ({ value }) => {
  return (
    <div>
      <label>Interval: {value.interval}s</label>
      <label>Source: {value.source}</label>
    </div>
  );
};

const SensorView: View<SensorConfig> = ({ value, ctx }) => {
  const readings = useChildren(ctx!.node.$path, { limit: 10, watchNew: true });

  return (
    <div>
      <h3>Sensor: {ctx!.node.$path}</h3>
      {readings.map(r => (
        <div key={r.$path}>
          {(r as SensorReading).value?.toFixed(1)} @ {new Date((r as SensorReading).ts).toLocaleTimeString()}
        </div>
      ))}
    </div>
  );
};

// register принимает Class<T> — типы пробрасываются автоматически
register(SensorConfig, 'react', ConfigView);
register(SensorConfig, 'react:list', SensorView);
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
import { createNode } from '#core';

await store.set(createNode('/sensors/temp', 'sensor', {
  config: { $type: 'sensor.config', interval: 10, source: 'internal' },
}));

await store.set(createNode('/sys/autostart/temp-sensor', 'ref', {
  $ref: '/sensors/temp',
}));
```
