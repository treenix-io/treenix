# 02 — Core API

## Типы

```ts
import {
  type NodeData,        // { $path, $type, $rev?, $owner?, $acl?, ...components }
  type ComponentData,    // { $type, $acl?, ...data }
  type GroupPerm,        // { g: string, p: number }
  type Ref,              // { $type: 'ref', $ref: string }
  R, W, A, S,           // ACL bits: Read=1, Write=2, Admin=4, Subscribe=8
} from '#core';
```

## Создание нод

```ts
import { createNode } from '#core';

const node = createNode('/tasks/1', 'task', {
  metadata: { $type: 'metadata', title: 'Hello' },
  status:   { $type: 'status', value: 'draft' },
});
```

## Работа с компонентами

```ts
import { getComponent, setComponent, removeComponent, getComponentsByType } from '#core';

getComponent(node, 'metadata');              // → { $type, title } | undefined
getComponentsByType(node, 'status');         // → [['status', { $type, value }]]
setComponent(node, 'status', { $type: 'status', value: 'done' });
removeComponent(node, 'status');             // → boolean
```

## Ссылки

```ts
import { ref, isRef } from '#core';
import { resolveRef } from '#tree';

const r = ref('/tasks/1');        // { $type: "ref", $ref: "/tasks/1" }
isRef(r);                         // true
const target = await resolveRef(store, refNode); // → NodeData
```

## Пути

```ts
import { dirname, basename, join, isChildPath } from '#core';

dirname('/a/b');                  // → "/a"
basename('/a/b');                 // → "b"
join('/a', 'b');                  // → "/a/b"
isChildPath('/a', '/a/b');        // → true (direct child)
isChildPath('/a', '/a/b/c');      // → false (not direct)
isChildPath('/a', '/a/b/c', false); // → true (any depth)
```

## Утилиты типов

```ts
import { isComponent, isOfType } from '#core';

isComponent(value);               // value is ComponentData
isOfType<T>(value, 'my-type');    // value is ComponentData<T>
```
