# 12 — Naming, стили, правила

## Naming Convention

```
string          → core built-in: dir, ref, root, user, type, mount-point, autostart
t.*             → treenity infrastructure: t.mount.fs, t.mount.mongo, t.llm
{vendor}.*      → package types: acme.block.hero, acme.bot, order.status
```

Разделитель: только `.` (не `/`, не `@`, не `:`).
Паттерн: `{namespace}.{category}.{name}`.

## Стили

Используй **Tailwind CSS** классы, не inline styles. Tailwind 4 + `@tailwindcss/vite` подключены.

```tsx
// Правильно
<div className="flex gap-2 text-sm px-2 py-1 bg-muted rounded">

// Неправильно
<div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
```

Для составных компонентов используй shadcn/ui (`@/components/ui/*`): `Badge`, `Button`, `Input`, `Card` и др.

## Контексты — сводная таблица

| Контекст        | Тип handler                      | Назначение                  |
| --------------- | -------------------------------- | --------------------------- |
| `schema`        | `() => JSONSchema`               | JSON Schema для UI-форм     |
| `react`         | `FC<{ value, onChange? }>`       | React-компонент             |
| `react:compact` |                                  | fallback к `react`          |
| `text`          | `(data) => string`              | Текстовый рендер            |
| `action:*`      | `(ctx: ActionCtx, data) => any` | Серверный экшен             |
| `service`       | `(node, ctx) => ServiceHandle`  | Фоновый сервис              |
| `mount`         | `(config, parent, ctx, global) => Store` | Mount-адаптер       |
| `acl`           | `() => GroupPerm[]`              | ACL по умолчанию для типа   |
| `class`         | `Class<T>`                       | Registered component class  |
| `telegram`      | `(node, tgCtx) => void`         | Telegram-хэндлер            |

## Ошибки

```ts
import { OpError } from '#server/errors';

// Коды: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN'
throw new OpError('NOT_FOUND', 'Node not found: /path');
throw new OpError('CONFLICT', 'Stale revision');
```

`OpError` → автоматически маппится на tRPC error (NOT_FOUND → 404, CONFLICT → 409 и т.д.).

## Архитектурные правила

1. **Core < 500 строк.** Всё остальное — в контекстах и модах
2. **Zero dependencies в core.** Только TypeScript
3. **Layer model:** нижний слой не знает о верхнем
4. **Sealed registry:** нет переопределений, только расширение
5. **Компонент знает только свои данные.** Соседи — через `needs`
6. **Refs только на ноды** (`$ref: "/path"`), никогда глубокие пути
7. **Дети — по path prefix query**, не хранятся в родителе
8. **`$` prefix — системные поля.** В Mongo `$` ↔ `_` автоматически
9. **Fallback контекстов:** exact → default@same-ctx → strip suffix → recurse → null
