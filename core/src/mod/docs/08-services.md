# 08 — Сервисы

Фоновые процессы: боты, сенсоры, воркеры. `register(type, "service", handler)` → возвращает `{ stop() }`.

```ts
import { register, createNode, type NodeData } from '#core';
import { type ServiceHandle, type ServiceCtx } from '#contexts/service';

register('my-worker', 'service', async (node: NodeData, ctx: ServiceCtx) => {
  const timer = setInterval(async () => {
    await ctx.store.set(createNode(
      `${node.$path}/${Date.now()}`,
      'tick',
      { ts: Date.now() },
    ));
  }, 5000);

  return {
    stop: async () => clearInterval(timer),
  } satisfies ServiceHandle;
});
```

## Автозапуск

Создай ref-ноду в `/sys/autostart`:

```ts
import { createNode } from '#core';

await store.set(createNode('/my-worker', 'my-worker'));
await store.set(createNode('/sys/autostart/my-worker', 'ref', { $ref: '/my-worker' }));
```

При старте сервера `startServices(store)` обходит `/sys/autostart`, резолвит refs, вызывает service-хэндлеры.
