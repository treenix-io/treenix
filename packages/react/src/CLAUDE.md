## front
React admin SPA — node editor, tree browser, typed hooks, client cache.

### Файлы
- App.tsx — root layout: Tree sidebar + NodeEditor main panel
- hooks.ts — useNode, useChildren, useComponent, useAction, **useComp**, **useExecute**
- cache.ts — in-memory node cache, subscribePath/subscribeChildren
- trpc.ts — tRPC client setup
- Inspector.tsx — generic component inspector (key-based, not typed)
- AclEditor.tsx — ACL UI

### Конвенции
- **useComp(path, Class, key?)** — typed reactive proxy: data live, methods → trpc.execute.mutate
- **useExecute()** — stable callback for node-level/generic actions
- No magic `action: 'string'` in views — use useComp methods instead
- useNode/useChildren remain for raw node/children access
