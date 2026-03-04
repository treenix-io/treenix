# 08 — Сервисы

Фоновые процессы: боты, сенсоры, воркеры. `register(type, "service", handler)` → возвращает `{ stop() }`.

```ts
import { register, type NodeData } from '#core';
import { type ServiceHandle, type ServiceCtx } from '#contexts/service';

register('my-worker', 'service', async (node: NodeData, ctx: ServiceCtx) => {
  const timer = setInterval(async () => {
    await ctx.store.set({
      $path: `${node.$path}/${Date.now()}`,
      $type: 'tick',
      ts: Date.now(),
    } as NodeData);
  }, 5000);

  return {
    stop: async () => clearInterval(timer),
  } satisfies ServiceHandle;
});
```

## Автозапуск

Создай ref-ноду в `/sys/autostart`:

```ts
await store.set({ $path: '/my-worker', $type: 'my-worker' } as NodeData);
await store.set({ $path: '/sys/autostart/my-worker', $type: 'ref', $ref: '/my-worker' } as NodeData);
```

При старте сервера `startServices(store)` обходит `/sys/autostart`, резолвит refs, вызывает service-хэндлеры.
