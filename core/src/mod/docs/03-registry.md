# 03 — Registry — система контекстов

Единственный механизм расширения. `register(type, context, handler)` — привязать обработчик к типу в контексте.

```ts
import { register, resolve, render } from '#core';

// Регистрация
register('task', 'schema', () => ({ properties: { title: { type: 'string' } } }));
register('task', 'react',  MyComponent);
register('task', 'text',   (data) => `Task: ${data.title}`);

// Резолв (fallback: exact → default@same-ctx → strip suffix → recurse → null)
resolve('task', 'react:compact'); // → task@react:compact → default@react:compact → task@react → default@react → null

// Рендер
render(component, 'text');  // вызывает handler(component)
```

**Sealed registry:** дублирование `register()` молча игнорируется (HMR-safe). Переопределить нельзя. Расширяй через новые контексты (`react:mobile`), а не замену.

## Introspection

```ts
import { getRegisteredTypes, getContextsForType, getMeta } from '#core';

getRegisteredTypes('schema');        // → ['task', 'order', ...]
getContextsForType('task');          // → ['schema', 'react', 'text', 'action:publish']
getMeta('task', 'schema');           // → metadata объект или null
```
