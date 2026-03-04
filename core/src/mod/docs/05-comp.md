# 05 — registerComp — типизированные компоненты

Класс = схема полей + методы-экшены. Методы автоматически регистрируются как `action:{name}`.

```ts
import { registerComp, type CompClass } from '#comp';

class Status {
  value = 'draft';

  publish() {
    this.value = 'published';
  }

  archive() {
    this.value = 'archived';
  }
}

registerComp('order.status', Status);
// Автоматически: register('order.status', 'action:publish', handler)
//                register('order.status', 'action:archive', handler)
```

## getCtx() — доступ к Store из методов класса

Методы класса получают `this` = Immer draft (компонент). Для доступа к store, ноде и AbortSignal используй `getCtx()`:

```ts
import { getCtx, registerComp } from '#comp';
import { join, type NodeData } from '#core';

class Portfolio {
  risk = 0.5;

  setRisk(data: { value: number }) {
    this.risk = data.value;  // простая мутация — getCtx не нужен
  }

  async rebalance() {
    const { node, store } = getCtx();
    const { items } = await store.getChildren(join(node.$path, 'positions'));

    for (const pos of items) {
      await store.set(pos);
    }

    return { rebalanced: items.length };
  }

  async selfDestruct() {
    const { node, store } = getCtx();
    await store.remove(node.$path);
  }
}

registerComp('portfolio', Portfolio);
```

**Как это работает:** перед вызовом метода система ставит контекст в глобальную переменную. JS однопоточный — между установкой и первой синхронной строкой метода ничто не вклинится, поэтому `getCtx()` всегда захватывает правильный контекст.

**CompCtx:**
```ts
type CompCtx = {
  node: NodeData;       // полная нода (Immer draft в executeAction)
  store: Store;         // реактивный store
  signal: AbortSignal;  // таймаут 30с
};
```

**Правило:** если метод только мутирует `this` — getCtx не нужен. Если нужен store/node — `const ctx = getCtx()` на первой строке (до любого await).

## Needs — зависимости от соседних компонентов

```ts
class PublishedDate {
  date = '';

  stamp(data: unknown, siblings: Record<string, ComponentData>) {
    this.date = new Date().toISOString();
  }
}

registerComp('published-date', PublishedDate, { needs: ['status'] });
```

## Type-safe доступ к компонентам

```ts
import { getComp, setComp, newComp, getCompField } from '#comp';

const status = getComp(node, Status);           // → ComponentData<Status> | undefined
setComp(node, Status, { value: 'done' });       // обновляет поля
const fresh = newComp(Status, { value: 'new' }); // создаёт { $type: 'order.status', value: 'new' }

const [fieldName, comp] = getCompField(node, Status)!; // → ['status', {...}]
```

## JSDoc → JSON Schema

```ts
class BlockHero {
  /** @title Заголовок @description Главный заголовок страницы */
  title = '';
  /** @title Картинка @format image */
  image = '';
}

registerComp('block.hero', BlockHero);
// npm run schema → dist/schema/block.hero.json
```
