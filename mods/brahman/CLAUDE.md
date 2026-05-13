## brahman
Telegram bot constructor. Pages with ordered actions, DnD menu editor, session/user management.

### Files
- types.ts — 24 component classes (BotConfig, PageConfig, 20 action types, User, Session)
- service.ts — Grammy bot runtime: middleware, template engine, 20 action handlers via register()
- action.ts — server-side action:run for brahman.page (tRPC execute)
- views/action-cards.tsx — icons, summaries, editors for all 20 action types
- views/page-layout.tsx — DnD sortable action list (@dnd-kit)
- views/menu-editor.tsx — DnD button/row editor for inline/reply keyboards
- views/bot-view.tsx — bot config view (token, langs, maintenance)
- views/tstring-input.tsx — TString multilingual text editor

### Conventions
- Action handlers registered via `register('brahman.action.X', 'brahman:run', handler)` — no switch/case
- TString = Record<string, string> for multilingual text (keyed by lang code)
- Template engine: Handlebars-like {var}, {{#ifEquals}}, {{#tag}}, {{eval expr}}
- Views go in views/, registered in view.ts for 'react' and 'react:list' contexts
