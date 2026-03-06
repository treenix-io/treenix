# 10 — ACL, валидация, volatile

## ACL

```ts
import { R, W, A, S, type GroupPerm } from '#core';

// R=1 Read, W=2 Write, A=4 Admin, S=8 Subscribe
// p > 0: allow bits
// p = 0: deny all (sticky)
// p < 0: deny specific bits (sticky)

node.$acl = [
  { g: 'admin',         p: R | W | A | S }, // всё
  { g: 'authenticated', p: R | S },          // чтение + подписка
  { g: 'public',        p: R },              // только чтение
  { g: 'banned',        p: 0 },              // блок (sticky)
];
node.$owner = 'user123';
```

Уровни: node-level (`$acl`, `$owner`) + component-level (`register(type, "acl", handler)`).

ACL на тип по умолчанию:

```ts
register('secret', 'acl', () => [{ g: 'admin', p: R | W | A | S }]);
```

## Валидация

`withValidation(store)` — write-barrier: проверяет компоненты против JSON Schema перед store.set().

```ts
import { withValidation } from '#server/validate';

const validated = withValidation(store);
// validated.set() бросит ошибку, если компонент не проходит schema
```

## Volatile Nodes

Ноды с `$volatile: true` хранятся только в памяти, не персистятся на диск/Mongo.

```ts
import { withVolatile } from '#server/volatile';

const store = withVolatile(backingStore);
await store.set(createNode('/temp', 'session', { $volatile: true }));
```

## Server Pipeline

```
bootstrap store (fs/mongo)
  → mountable (mount system)
    → volatile (memory-only nodes)
      → validated (JSON Schema check)
        → subscriptions (events + CDC)
```
