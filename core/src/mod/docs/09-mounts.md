# 09 — Mount-адаптеры

Маршрутизация поддеревьев к другим бэкендам. Всё под `/mount-point/*` обслуживается подключённым Store.

```ts
register('my-adapter', 'mount', async (config, parentStore, ctx, globalStore) => {
  return createMongoStore(config.uri, config.db, config.col);
});
```

Нода с маунтом:

```ts
await store.set(createNode('/external', 'my-adapter', {
  connection: { $type: 'connection', uri: '...', db: 'x', col: 'y' },
  mount: { $type: 'my-adapter' },
}));
// Всё под /external/* теперь идёт в Mongo-коллекцию
```

## Встроенные маунты

| Тип | Назначение |
|-----|-----------|
| `t.mount.mongo` | MongoDB-коллекция |
| `t.mount.fs` | Файловая система |
| `t.mount.memory` | In-memory (volatile) |
| `t.mount.overlay` | Overlay двух store |
| `t.mount.query` | Виртуальная папка с sift-фильтром |
| `t.mount.types` | Интроспекция registry |

## Query Mounts — виртуальные папки

```ts
await store.set(createNode('/orders/incoming', 't.mount.query', {
  mount: {
    $type: 't.mount.query',
    source: '/orders/data',
    match: { status: { value: 'incoming' } },
  },
}));
// GET /orders/incoming → только ноды из /orders/data с status.value === 'incoming'
```
