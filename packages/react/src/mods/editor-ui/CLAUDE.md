# editor-ui

View-слой админки. Fallback `react`-рендерер для всех нод/компонентов, специализированные views (layout, page, dir, user, list), schema-driven form fields для NodeEditor.

## Items vs Chrome convention

`react:list`, `react:card`, `react:icon` views = **content only** (fragment / inner divs). Chrome (border, padding, click-to-nav, hover, layout) делает наблюдатель через `<RenderChildren items ctx />` из [list-items.tsx](list-items.tsx).

- Default fallback items: `default`, `dir`, `ref` — уже зарегистрированы для `react:list`/`react:card`/`react:icon`.
- Single-item: `<RenderItem value ctx />`.
- Реализуй переключатель контекста в наблюдателе если хочешь list/card/icon view (см. [dir-view.tsx](dir-view.tsx)).
- Подробности и примеры — `packages/react/src/CLAUDE.md`.
