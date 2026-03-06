# 07 — Подписки и React

## Серверная сторона

```ts
import { withSubscriptions, type ReactivStore, type NodeEvent } from '#server/sub';

type NodeEvent =
  | { type: 'set';    path: string; node: NodeData; patches?: Patch[] }
  | { type: 'patch';  path: string; patches: Patch[] }
  | { type: 'remove'; path: string };

const reactive: ReactivStore = withSubscriptions(store);

const unsub = reactive.subscribe('/tasks', (event: NodeEvent) => {
  // срабатывает на /tasks, /tasks/1, /tasks/1/sub, ...
});
unsub();
```

В сервисе store уже реактивный. `store.set()` / `store.remove()` автоматически нотифицируют подписчиков.

## CDC Matrix (Query Mounts)

При store.set() подписки автоматически проверяют все активные query mount-ы. Если нода вошла/вышла из фильтра — генерируются `addVps` / `rmVps` в событии. Клиентский кэш автоматически добавляет/убирает ноду из виртуальных папок.

## React хуки

```ts
import { useNode, useChildren, useComponent, useAction, useNodeCount } from '#front/hooks';

const [node, setNode] = useNode('/tasks/1');
await setNode({ ...node, title: 'Updated' }); // optimistic → server → refetch

const children = useChildren('/tasks', {
  watch: true,       // подписаться на изменения существующих
  watchNew: true,    // подписаться на появление новых
  limit: 50,
});

const [comp, setComp] = useComponent('/tasks/1', 'status');
await setComp({ $type: 'status', value: 'done' });

const results = useAction('/dashboard', 'stats');
const count = useNodeCount();
```

## Рендер через контекст

```tsx
import { Render, RenderContext, NodeProvider, useCurrentNode, useTreeContext } from '#contexts/react';

<Render value={component} onChange={handler} />

<RenderContext name="react:compact">
  <Render value={component} />  {/* ищет react:compact → react → default */}
</RenderContext>

function MyRenderer({ value, onChange }) {
  const node = useCurrentNode();
  const context = useTreeContext();
  return <div>{value.title}</div>;
}
```

## react:list — самодостаточные list-item компоненты

```tsx
import type { View } from '@treenity/react/context';

// View для default — value: ComponentData (базовый тип, есть $type)
const DefaultListItem: View<ComponentData> = ({ value, ctx }) => {
  const node = ctx!.node;
  return (
    <div className="child-card" onClick={() => navigate(node.$path)}>
      <span className="child-icon">{typeIcon(node.$type)}</span>
      <div className="child-info">
        <span className="child-name">{pathName(node.$path)}</span>
        <span className="child-type">{node.$type}</span>
      </div>
      <span className="child-chevron">&#8250;</span>
    </div>
  );
};
register('default', 'react:list', DefaultListItem);
```

Fallback: `react:list` → `default@react:list` → strip `:list` → `react`.

## Нода КАК компонент — flat fields

Когда `node.$type` совпадает с `$type` компонента, нода **сама является** компонентом. Поля лежат плоско:

```ts
import { createNode } from '#core';

// Правильно — createNode создаёт типизированную ноду
await store.set(createNode('/bot', 'brahman.bot', { token: '...', alias: '@bot' }));

// Неправильно — вложенный компонент с тем же $type что и нода
await store.set(createNode('/bot', 'brahman.bot', {
  config: { $type: 'brahman.bot', token: '...' },  // WRONG: дублирует $type
}));
```

## Views — read-only

View (`react` контекст) — только отображение. Редактирование — через NodeEditor (edit panel + schema forms).
