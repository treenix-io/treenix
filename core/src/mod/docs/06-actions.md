# 06 — Экшены

Экшен — метод класса компонента. Сервер исполняет его через Immer draft, патчи
автоматически сохраняются. Если данные не менялись — store.set() не вызывается.

## Шаг 1: определи экшены как методы класса

```ts
import { registerComp } from '#comp';

export class OrderStatus {
  value: 'incoming' | 'kitchen' | 'ready' = 'incoming';

  advance() {
    // this — Immer draft компонента
    if (this.value === 'incoming') this.value = 'kitchen';
    else if (this.value === 'kitchen') this.value = 'ready';
  }
}

registerComp('order.status', OrderStatus);
```

Всё. `registerComp` автоматически регистрирует `action:advance` из метода.

## Шаг 2: вызов из React-вьюшки

```tsx
import { useComp } from '#front/hooks';
import { OrderStatus } from './types';

function OrderCard({ path }: { path: string }) {
  const status = useComp(path, OrderStatus);
  // status.value    — live данные из кэша (реактивно)
  // status.advance() — вызывает trpc.execute, получает ответ

  return (
    <button onClick={() => status.advance()}>
      {status.value} →
    </button>
  );
}
```

`useComp(path, Class, key?)` — одна точка для данных и действий.
- `key` нужен только если на ноде несколько компонентов одного `$type`.

## Шаг 3: вызов из сервиса / серверного кода

```ts
import { createServerNodeClient } from '#server/actions';
import { OrderStatus } from '../orders/types';

register('my.service', 'service', async (node, ctx) => {
  const nc = createServerNodeClient(ctx.store);

  await nc('/orders/123').get(OrderStatus).advance();
  // Typed: IDE подсказывает методы и аргументы
});
```

`key` можно опустить: если ключ поля совпадает с последним сегментом `$type`
(`'order.status'` → `'status'`), сканирование находит компонент автоматически.

## Методы с аргументами

```ts
export class PultConfig {
  risk = 0.5;

  setRisk(data: { value: number }) {
    this.risk = Math.max(0, Math.min(1, data.value));
  }
}
```

```tsx
// React:
const cfg = useComp(path, PultConfig);
<Fader onChange={v => cfg.setRisk({ value: v })} />

// Сервис:
await nc(path).get(PultConfig).setRisk({ value: 0.1 });
```

## Сигнатура = порты + параметры

Тип `data`-аргумента метода — единый источник правды для двух контекстов:

```ts
class Invoice {
  static $type = 'billing.invoice'

  async charge(data: { amount: number, account: Account, user?: User }) {
    data.account.debit(data.amount)
    data.user?.notify('charged')
  }
}
```

| В коде | В визуальном редакторе |
|--------|----------------------|
| `amount: number` — параметр, передаётся при вызове | Поле ввода на кубике |
| `account: Account` — typed значение | **Порт** — входной разъём типа Account, тянешь провод |
| `user?: User` — optional параметр | **Опциональный порт** — можно не подключать |

**Вызов из кода** — обычный typed call:
```ts
invoice.charge({ amount: 10, account: user.account })
```

**Компиляция графа** — визуальный редактор собирает значения с подключённых портов:
```ts
// wired connections → data object:
invoice.charge({
  amount: amountNode.value,
  account: getComp(acmeNode, Account),
})
```

Одна TypeScript-сигнатура, два мира. TypeScript проверяет типы при компиляции,
JSON Schema генерируется для AI/валидации. Без отдельного DSL для портов.

## Async-методы и доступ к store

> **Правило:** `getCtx()` вызывай только синхронно на первой строке метода — до первого `await`/`yield`.
> После `await` контекст уже не валиден (async stack ушёл).



```ts
import { getCtx } from '#comp';

export class PultConfig {
  async rebalance() {
    const { node, store } = getCtx(); // ТОЛЬКО на первой строке — до первого await

    const { items: markets } = await store.getChildren(`${node.$path}/markets`);
    for (const m of markets) {
      // ...
    }
    return { rebalanced: markets.length };
  }
}
```

## Generator-экшены — стримят результаты клиенту

```ts
export class Builder {
  async *build(data: { count: number }) {
    const { node, store, signal } = getCtx(); // ТОЛЬКО здесь — до любого await/yield

    for (let i = 0; i < data.count; i++) {
      if (signal.aborted) return;
      const item = await buildItem(i);
      await store.set(item);
      yield item; // нода → клиент кладёт в кэш
    }
  }
}
```

```ts
// Подписка на стрим:
trpc.streamAction.subscribe({ path, action: 'build', data: { count: 10 } }, {
  onData(item) { /* nodes → cache */ },
});
```

---

## Справка: низкоуровневые вызовы

Используй только если `useComp`/`createServerNodeClient` не подходят
(generic Inspector, MCP, внешние интеграции).

```ts
// Прямой вызов (type scan без key):
await executeAction(store, path, 'order.status', undefined, 'advance');

// С конкретным key:
await executeAction(store, path, 'order.status', 'status', 'advance');

// Node-level (без компонента):
await executeAction(store, path, undefined, undefined, 'doStuff');

// tRPC напрямую:
trpc.execute.mutate({ path, type: 'order.status', action: 'advance' });
trpc.execute.mutate({ path, type: 'order.status', key: 'status', action: 'advance' });
```

Resolution: key → node[key] + verify $type; type only → findCompByType scan; neither → node.$type scan.
