# Treenix Module Format

Модуль — отдельный npm-пакет, подключаемый к любому инстансу Treenix.

## Структура пакета

```
treenix-mod-weather/
  package.json
  src/
    index.ts          — defineMod() — точка входа
    types.ts          — registerType() — компоненты
    service.ts        — register(type, 'service', ...) — сервисы
    view.tsx          — register(type, 'react', ...) — React-рендеры
    schemas.ts        — register(type, 'schema', ...) — JSON Schema
```

## package.json

```json
{
  "name": "treenix-mod-weather",
  "version": "1.0.0",
  "peerDependencies": {
    "@treenx/core": "^0.1.0"
  },
  "treenix": {
    "name": "weather",
    "version": "1.0.0",
    "types": ["weather.sensor", "weather.config", "weather.reading"],
    "dependencies": ["core-sensors"],
    "server": "./dist/server.js",
    "client": "./dist/client.js",
    "seed": "./dist/seed.js"
  }
}
```

Поле `treenix` — маркер для автоматического обнаружения. Без него пакет игнорируется.

| Поле | Назначение |
|------|-----------|
| `name` | Имя модуля (если не указано, берётся из `package.name`) |
| `version` | Версия модуля (fallback: `package.version`) |
| `types` | Типы, которые модуль регистрирует (для интроспекции) |
| `dependencies` | Другие модули, которые нужно загрузить первыми |
| `server` | Entry point для серверных регистраций |
| `client` | Entry point для клиентских регистраций (views, schemas) |
| `seed` | Entry point для seed-данных |

## defineMod() — точка входа

```ts
// src/index.ts
import { defineMod } from '@treenx/core';

export default defineMod({
  name: 'weather',
  version: '1.0.0',
  types: ['weather.sensor', 'weather.config'],
  dependencies: [],

  // Ленивая загрузка серверных регистраций
  server: () => import('./types').then(() => import('./service')),

  // Ленивая загрузка клиентских регистраций
  client: () => import('./types').then(() => import('./view')),

  // Seed: создание начальных нод
  seed: async (store) => {
    const existing = await store.get('/sensors/weather');
    if (existing) return; // идемпотентно

    await store.set(createNode('/sensors/weather', 'weather.sensor', {
      config: { $type: 'weather.config', location: 'Moscow', interval: 60 },
    }));

    await store.set(createNode('/sys/autostart/weather', 'ref', {
      $ref: '/sensors/weather',
    }));
  },

  onLoad: () => console.log('Weather mod loaded'),
  onUnload: () => console.log('Weather mod unloaded'),
});
```

## Обнаружение

```ts
import { discoverMods } from '#mod';

// Сканирует node_modules, ищет пакеты с полем "treenix" в package.json
const manifests = await discoverMods('./node_modules');
// → [{ name: 'weather', version: '1.0.0', types: [...], server: '...', ... }]
```

Поддерживает: обычные пакеты, scoped пакеты (`@org/treenix-mod-*`), произвольные имена.

## Загрузка

```ts
import { discoverMods, loadMods } from '#mod';

const manifests = await discoverMods('./node_modules');
const result = await loadMods(manifests, 'server', store);

console.log(result.loaded);  // ['core-sensors', 'weather'] — в порядке зависимостей
console.log(result.failed);  // [{ name: 'broken-mod', error: Error }]
```

`loadMods()` автоматически:
1. Сортирует по зависимостям (Kahn's algorithm)
2. Проверяет что зависимости загружены
3. Импортирует server/client entry point
4. Вызывает `onLoad()`
5. Seed (если target = server и передан store)
6. Отслеживает состояние в реестре

### Ошибки загрузки

- Неизвестная зависимость → `Error: Mod "X" depends on unknown mod "Y"`
- Циклическая зависимость → `Error: Circular dependency among mods: A, B, C`
- Ошибка загрузки → модуль помечается `state: 'failed'`, остальные продолжают грузиться

## Реестр

```ts
import { getLoadedMods, getMod, isModLoaded } from '#mod';

getLoadedMods();                 // → LoadedMod[]
getMod('weather');               // → { manifest, mod, state: 'loaded', loadedAt }
isModLoaded('weather');          // → true
```

## Dev workflow

Полный рабочий пример — [examples/ticker/](examples/ticker/) — types, service, view, seed, test.
Скопируй, адаптируй под свой мод.

**Подключение (добавить импорты):**
```ts
// src/mods/index.ts
import './ticker/types';
import './ticker/service';

// src/mods/views.ts
import './ticker/view';
```

**Запуск:**
```bash
npm run dev:server    # tsx --watch
npm run dev:front     # vite HMR
```

**Дебаг сервера через Chrome DevTools:**
```bash
node --inspect -r tsx/esm src/server/index.ts
# → chrome://inspect
```

**Тест:**
```bash
npx tsx --test src/mods/ticker/ticker.test.ts
```

**Готово → npm:**
```bash
mkdir treenix-mod-ticker && cd treenix-mod-ticker
npm init
# Скопировать файлы, заменить @/ на @treenx/core, добавить "treenix" в package.json
npm publish
```

---

## Typed Signatures — контракты между модами

Модули связываются через типы. Класс компонента — экспортируемый контракт:

```ts
// treenix-mod-accounting
export class Account {
  static $type = 'accounting.account'
  balance = 0

  debit(data: { amount: number }) { this.balance -= data.amount }
}
```

```ts
// treenix-mod-billing — зависит от accounting
import { Account } from 'treenix-mod-accounting'

export class Invoice {
  static $type = 'billing.invoice'

  async charge(data: { amount: number, account: Account }) {
    data.account.debit({ amount: data.amount })
  }
}
```

`account: Account` в сигнатуре — это одновременно:
- **Типизированный параметр** при вызове из кода: `invoice.charge({ amount: 10, account })`
- **Порт** в визуальном редакторе: входной разъём, к которому подключается Account-нода

Никакого DI-фреймворка, event bus, plugin API. ES import класса = зависимость.
TypeScript проверяет, JSON Schema генерируется для AI/UI.

---

## Optimistic Updates

Класс компонента — shared kernel между клиентом и сервером. Один код, две среды:
- **Сервер:** метод выполняется через Immer draft → patches → store.set()
- **Клиент:** тот же метод выполняется на клоне → мгновенный UI → сервер подтверждает или откатывает

### OptimisticBuffer

```ts
import { OptimisticBuffer } from '#mod';

const buf = new OptimisticBuffer();
```

### Цикл: apply → confirm/rollback

```ts
// 1. Юзер жмёт кнопку — применяем оптимистично
const { predicted, mutationId } = buf.apply(
  node,                              // текущая нода
  'order.status',                    // тип компонента
  'advance',                         // имя метода
  (target, data) => target.advance(),// метод
  undefined,                         // data (аргументы метода)
);
// predicted — нода с предсказанным результатом
// → обновить кэш: cache.put(predicted)

// 2. Отправить экшен на сервер
trpc.execute.mutate({ path: '/orders/1', type: 'order.status', action: 'advance' });

// 3. Сервер отвечает через подписку (SSE patches)
const { node: final, rolledBack } = buf.confirm('/orders/1', serverNode);
// rolledBack = false → предсказание совпало
// rolledBack = true  → сервер вернул другое, откатили

cache.put(final);
```

### Множественные мутации

Мутации на одном пути стакаются. При подтверждении первой — остальные ребейзятся:

```ts
buf.apply(counter0, 'counter', 'increment', incMethod, undefined);  // → count: 1
buf.apply(counter1, 'counter', 'increment', incMethod, undefined);  // → count: 2
buf.apply(counter2, 'counter', 'increment', incMethod, undefined);  // → count: 3

buf.getPendingCount('/counters/1');  // → 3
buf.getOptimistic('/counters/1');    // → { count: 3 }

// Сервер подтверждает первое (count=1)
buf.confirm('/counters/1', serverNode);  // rebase: оставшиеся 2 переигрываются
buf.getPendingCount('/counters/1');      // → 2
```

### Конфликт — сервер всегда прав

```ts
buf.apply(order, 'order.status', 'advance', advanceMethod, undefined);

const { node, rolledBack } = buf.confirm('/orders/1', cancelledOrder);
// rolledBack = true, все pending сброшены
// node = cancelledOrder (серверная версия)
```

### API

```ts
buf.hasPending('/path');             // есть ли ожидающие мутации
buf.getPendingCount('/path');        // сколько
buf.getPendingCount();               // всего по всем путям
buf.rollback('/path');               // откатить всё, вернуть baseline
buf.rollbackById(mutationId);        // откатить конкретную мутацию
buf.confirmById(mutationId);         // подтвердить конкретную
buf.expire(30_000);                  // удалить мутации старше 30с
buf.clear();                         // сбросить всё
```

### Как работает внутри

1. `apply()` — `structuredClone(node)` → найти компонент → вызвать метод → сохранить baseline + predicted + method + data
2. `confirm()` — сравнить predicted с serverNode (без $rev) → совпало? drop. нет? rollback all.
3. `rebase()` — переиграть оставшиеся мутации на новой базе, используя сохранённые method + data
4. `expire()` — таймаут для зависших мутаций (сервер не ответил)

**Почему хранится method + data:** `structuredClone()` стирает прототипы. Без сохранённой ссылки на метод rebase не может переиграть мутации.

---

## Views — register / Render / RenderContext

Вьюхи НИКОГДА не рендерят дочерние компоненты напрямую. Всё через реестр:

### Регистрация — типобезопасная

```tsx
import { register } from '@treenx/core';
import type { View } from '@treenx/react/context';
import { Render, RenderContext } from '@treenx/react/context';

// View<T> — типизированный React-компонент: { value: T, ctx?, onChange? }
const SensorView: View<WeatherSensor> = ({ value, ctx }) => {
  const path = ctx!.node.$path;  // путь ноды — через ctx, НЕ из value
  return <div>{value.location} — {value.temperature}°C</div>;
};

const SensorRow: View<WeatherSensor> = ({ value, ctx }) => { ... };

// register принимает Class<T> — T пробрасывается в handler автоматически
register(WeatherSensor, 'react', SensorView);          // detail view
register(WeatherSensor, 'react:list', SensorRow);      // compact list view
```

**ЗАПРЕЩЕНО:**
```tsx
// WRONG — as any убивает типизацию, прячет ошибки:
register('weather.sensor', 'react', SensorView as any);

// WRONG — NodeData не смешивать с типами компонентов:
function SensorRow({ value }: { value: NodeData & WeatherSensor }) { ... }

// WRONG — путь из value (value — данные компонента, не нода):
const path = value.$path;  // может не существовать!
```

### Рендер дочерних — ТОЛЬКО через `<Render>`

```tsx
// WRONG — хардкод, обходит реестр:
{sensors.map(s => <SensorRow key={s.$path} sensor={s} />)}

// RIGHT — через реестр, композабельно:
<RenderContext name="react:list">
  {sensors.map(s => <Render key={s.$path} value={s} />)}
</RenderContext>
```

### Контексты

| Контекст | Назначение |
|----------|-----------|
| `react` | default/detail view |
| `react:list` | компактная карточка для списков |
| `react:edit` | форма редактирования |

Fallback автоматический: `react:list` → `react` → `default`.

### Сигнатура view-функции

```tsx
// View<T> даёт: value: T, ctx: ViewCtx (node, path, execute), onChange
const SensorView: View<WeatherSensor> = ({ value, ctx }) => {
  // value — данные компонента (WeatherSensor fields)
  // ctx!.node — полная NodeData (с $path, $type, $acl и т.д.)
  // ctx!.execute(action, data) — вызов экшена
};
```

### Почему это важно

- **Композиция:** любой тип рендерит чужих детей, не зная их вьюх
- **Переопределение:** зарегистрируй новый `react:list` для типа → все списки обновятся
- **AI visibility:** реестр интроспектируемый, AI находит доступные вьюхи
