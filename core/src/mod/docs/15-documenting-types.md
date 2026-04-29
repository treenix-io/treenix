# 15 — JSDoc-аннотации для типов

## Как работает

```
Class JSDoc → extract-schemas.ts → src/schema/generated/*.json → registry('schema') → Inspector / MCP / Client
```

`registerType(type, Class)` регистрирует класс. Схемы генерируются автоматически при старте dev-сервера (сканируется AST, извлекается JSDoc → JSON Schema). `npm run schema` — для CI или без перезапуска. Схема загружается через `register(type, 'schema', () => schema)`. Три потребителя:

1. **Inspector** — рендерит формы с лейблами, подсказками, виджетами
2. **MCP** — `catalog`, `describe_type`, `search_types` для AI-discovery
3. **TypeCatalog** — программный доступ к каталогу типов из любого контекста

## Справочник тегов

| Тег | Где | Результат | Пример |
|-----|-----|-----------|--------|
| _(первая строка)_ | Класс | `schema.title` — название типа | `/** Contact form — receives submissions */` |
| `@title` | Свойство/метод | `title` — лейбл в форме | `@title Recipient` |
| `@description` | Свойство/метод | `description` — подсказка | `@description SMTP address` |
| `@format` | Свойство | UI-виджет (см. таблицу ниже) | `@format image` |
| `@refType` | Свойство | Ссылка на тип компонента (auto-detect если тип = registered class) | `@refType cafe.mail` |
| `@pre` | Метод | Поля-предусловия (через пробел) | `@pre source trust` |
| `@post` | Метод | Поля-результаты (через пробел) | `@post lastSubmission` |

Префикс `_` в имени метода скрывает его из схемы.

## Значения @format

| Format | Виджет | Для чего |
|--------|--------|----------|
| `image` | URL + превью | Ссылки на изображения |
| `textarea` | Многострочное поле | Длинный текст, JSON, описания |
| `uri` | URL + кликабельная ссылка | Внешние ссылки |
| `email` | Текстовое поле | Email-адреса |
| `path` | Поле пути | Treenix node paths (auto при refType) |
| `tags` | Чипсы с add/remove | Массивы тегов |
| `tstring` | Мультиязычный редактор | Переводы `{ ru: "...", en: "..." }` |
| `timestamp` | Форматированная дата | Unix-метки времени |

Без `@format` — рендерится по типу (`string` → input, `number` → number input, `boolean` → checkbox).

## Примеры

### Data-only компонент

**Плохо** — Inspector покажет сырой JSON:
```typescript
class BlockHero {
  title = '';
  image = '';
}
registerType('mabu.block.hero', BlockHero);
```

**Хорошо** — Inspector покажет формы с лейблами и виджетами:
```typescript
/** Hero banner — full-width section with title, subtitle, CTA */
class BlockHero {
  /** @title Title @description Page title */
  title = '';
  /** @title Background image @format image */
  image = '';
  /** @title Button text @description Learn more */
  cta = '';
}
registerType('mabu.block.hero', BlockHero);
```

### Компонент с экшенами

**Плохо** — MCP `catalog` покажет экшен без описания:
```typescript
class OrderStatus {
  value = 'incoming';
  advance() { /* ... */ }
}
```

**Хорошо** — AI видит и понимает экшен:
```typescript
/** Kitchen order status — advances through incoming → kitchen → ready */
class OrderStatus {
  /** @title Status */
  value: string = 'incoming';
  /** @description Advance order to next stage in the flow */
  advance() { /* ... */ }
}
registerType('order.status', OrderStatus);
```

### Кросс-ссылки (refType)

```typescript
/** Contact form — receives submissions, logs them */
class CafeContact {
  /** @title Recipient @format email */
  recipient = '';
  /** @title Mail service */
  mailService?: CafeMailService; // auto-detect → refType: "cafe.mail"

  /** @description Submit contact form — validates and logs */
  submit(data: { name: string; email: string; message: string }) { /* ... */ }
}
registerType('cafe.contact', CafeContact);
```

### Внешние экшены (register-based)

```typescript
/** @description Start the Telegram bot polling loop */
register('brahman.bot', 'action:start', startHandler);
```

## Чеклист

1. Каждый класс — JSDoc на первой строке: `/** {Noun} — {what it does} */`
2. Каждое публичное свойство — `@title` (лейбл формы)
3. `@description` для подсказок (необязательно, но рекомендуется)
4. `@format` когда нужен специальный виджет
5. Каждый публичный метод — `@description` (экшен в MCP/Inspector)
6. `_` prefix для скрытых/внутренних методов
7. `@refType` auto-detect для свойств с типом registered class
8. `@pre`/`@post` для документирования зависимостей между полями
9. Схемы генерируются автоматически при старте dev-сервера (`npm run schema` — для CI)
10. Проверить: `src/schema/generated/{type}.json` — title, properties, methods

## Промпт для LLM

Копируй как system instructions для AI, который создаёт или документирует типы:

```
## Treenix Type Annotation Rules

When creating or documenting a Treenix component class:

1. CLASS: one-line JSDoc `/** {Noun phrase} — {what it does} */`
2. PROPERTIES: `/** @title {Label} @description {hint} @format {widget} */`
   - @title = form label (required for every public field)
   - @description = placeholder/explanation (recommended)
   - @format = image | textarea | uri | email | path | tags | tstring | timestamp
3. METHODS: `/** @description {verb phrase — what the action does} */`
   - Methods with _ prefix are hidden from schema
   - Typed args: method(data: { field: type }) auto-generates argument schema
4. CROSS-REFS: use registered class as property type for auto refType
   mailService?: CafeMailService → generates refType: "cafe.mail"
5. EXTERNAL ACTIONS: JSDoc before register() call
   /** @description Start the bot */ register('bot', 'action:start', handler)
6. DISCOVERY: use MCP tools to explore existing types:
   - catalog → list all types with titles
   - describe_type(name) → full schema + cross-references
   - search_types(query) → find by keyword

Schemas auto-generate on dev server startup. For CI: npm run schema. Verify: src/schema/generated/{type}.json
```
