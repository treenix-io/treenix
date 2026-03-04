# 01 — Три примитива

```
Node      = { $path, $type, ...components }   // сущность в дереве
Component = { $type, ...data }                 // именованный аспект ноды
Context   = register(type, context, handler)   // поведение типа в контексте
```

Нода — это `$path` + `$type` + произвольные компоненты. Компонент — именованное поле с `$type`. Контекст привязывает поведение (рендер, экшен, сервис) к типу.

Системные поля: `$path`, `$type`, `$rev` (OCC), `$owner`, `$acl`.

## Структура мода

```
src/mods/my-mod/
  types.ts      — registerComp() — классы компонентов, данные + экшены
  action.ts     — register(type, 'action:name', handler) — node-level экшены
  schemas.ts    — register(type, 'schema', () => ({...})) — JSON Schema для UI
  view.tsx      — register(type, 'react', Component) — React-рендеры
  service.ts    — register(type, 'service', handler) — фоновый сервис
```

Регистрация:
- Сервер: добавь импорт в `src/mods/index.ts`
- Фронтенд: добавь импорт в `src/mods/views.ts` + `registerViews()`

## Dev workflow

```bash
npm run schema        # извлечь JSON Schema из JSDoc → dist/schema/
npm test              # tsx --test src/**/*.test.ts
npm run dev:server    # tsx --watch src/server/index.ts (порт 3001)
npm run dev:front     # vite (React-фронт)
```

Seed-данные: `data/base/` (git-tracked), runtime-данные: `data/work/` (gitignored).
Overlay: work поверх base — записи идут в work, чтение fallback на base.
