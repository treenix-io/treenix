# 04 — Store — доступ к данным

## Интерфейс

```ts
import { type Store, type Page, type ChildrenOpts } from '#tree';

store.get(path);                                    // → NodeData | undefined
store.set(node);                                    // upsert (OCC по $rev)
store.remove(path);                                 // → boolean
store.getChildren(path, { depth, limit, offset });  // → Page<NodeData>
```

`Page<T> = { items: T[], total: number }`

## OCC (Optimistic Concurrency Control)

Если нода имеет `$rev`, store.set() проверяет совпадение и бросает ошибку при конфликте:

```ts
const node = await store.get('/tasks/1');
node.status.value = 'done';
await store.set(node); // если $rev изменился — OptimisticConcurrencyError
```

## Реализации

```ts
import { createMemoryStore } from '#tree';
import { createFsStore } from '#tree/fs';
import { createMongoStore } from '#tree/mongo';

const mem   = createMemoryStore();
const fs    = await createFsStore('./data/base');
const mongo = await createMongoStore(uri, 'mydb', 'nodes');
```

## Комбинаторы

```ts
import { createOverlayStore, createFilterStore } from '#tree';

// Overlay: reads from upper first, writes go to upper only
const overlay = createOverlayStore(workStore, baseStore);

// Filter: routes set() по предикату (upper если true, lower если false)
const filtered = createFilterStore(hotStore, coldStore, (node) => node.$type === 'hot');
```

## Query Store (sift)

Виртуальная отфильтрованная проекция. Mongo-синтаксис через sift:

```ts
import { createQueryStore } from '#tree/query';

const incoming = createQueryStore(
  { source: '/orders/data', match: { status: { value: 'incoming' } } },
  parentStore,
);
// getChildren('/') → только ноды, где status.value === 'incoming'
```
