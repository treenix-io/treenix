# editor-ui

Admin view layer. Fallback `react` renderer for all nodes/components, specialised views (layout, page, dir, user, list), schema-driven form fields for NodeEditor.

## Items vs Chrome convention

`react:list`, `react:card`, `react:icon` views = **content only** (fragment / inner divs). Chrome (border, padding, click-to-nav, hover, layout) belongs to the observer via `<RenderChildren items ctx />` from [list-items.tsx](list-items.tsx).

- Default fallback items: `default`, `dir`, `ref` — already registered for `react:list` / `react:card` / `react:icon`.
- Single item: `<RenderItem value ctx />`.
- Implement a context switcher in the observer if you need list/card/icon views (see [dir-view.tsx](dir-view.tsx)).
- For details and examples — `packages/react/src/CLAUDE.md`.
