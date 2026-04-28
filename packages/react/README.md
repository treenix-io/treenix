# @treenx/react

**React binding for Treenix — reactive hooks, admin UI, and component rendering.**

Built on top of `@treenx/core`. Provides hooks for reading and mutating tree nodes, a context-based component renderer, and a full admin interface with node editor, inspector, and tree browser.

## Install

```bash
npm install @treenx/react @treenx/core react react-dom
```

## Hooks

```typescript
import { usePath, useChildren } from '@treenx/react/hooks';
import { TodoItem } from './types';

// Typed proxy — reactive data + action methods
const item = usePath('/todo/list/1', TodoItem);
item.title;          // reactive read
await item.toggle(); // tRPC mutation → Immer patch → SSE broadcast

// URI-based read (returns raw data)
const node = usePath('/todo/list/1');

// Reactive children list
const children = useChildren('/todo/list');
```

### Available Hooks

| Hook | Description |
|------|-------------|
| `usePath(uri)` | Reactive node read by URI string |
| `usePath(path, Class, key?)` | TypeProxy — reactive fields + typed action methods |
| `useChildren(path, opts?)` | Reactive children list with optional query filter |
| `useCanWrite(path)` | Check write permission for current user |
| `useNavigate()` | Navigation function for tree paths |
| `useCurrentNode()` | Current node from context |
| `useTreeContext()` | Current render context name |
| `useSchema(type)` | JSON schema for a type |
| `useReg(type, context)` | Resolve registered context handler |

## Component Rendering

Register React views per type + context:

```typescript
import { register } from '@treenx/core';

register('todo.item', 'react', ({ value, onChange }) => (
  <div>
    <span>{value.title}</span>
    <button onClick={() => onChange({ ...value, done: !value.done })}>
      {value.done ? 'Undo' : 'Done'}
    </button>
  </div>
));
```

Render any node with automatic type resolution:

```typescript
import { Render } from '@treenx/react/context';

<Render value={node} onChange={handleChange} />
```

## UI Components

Ships with shadcn/ui components (Tailwind CSS v4):

```typescript
import { Button } from '@treenx/react/ui/button';
import { Slider } from '@treenx/react/ui/slider';
```

## Admin UI

`<App />` provides a full admin interface: tree browser, node editor, inspector, ACL editor, login. Used as the default frontend during development.

## Links

- [@treenx/core](https://www.npmjs.com/package/@treenx/core)
- [GitHub](https://github.com/treenix-ai/treenix)
- [Getting Started](https://github.com/treenix-ai/treenix/blob/main/docs/getting-started.md)

## License

Licensed under FSL-1.1-MIT. Free to use for any purpose. Converts to MIT automatically after two years from each release date.
