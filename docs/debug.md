# Debugging Treenity

## Prerequisites

- Server running: `npx tsx src/server` (default port 3210)
- Vite dev server: same process serves frontend via vite middleware

## Browser Console (`__tree`)

In dev mode, the unified client store is exposed as `window.__tree`.

```js
// Read any node (local or remote — same API)
await __tree.get('/orders/123')
await __tree.get('/local/ui/theme')

// Write a local-only node (never hits the server)
await __tree.set({ $path: '/local/ui/theme', $type: 'theme', dark: true })

// List children (merges local + remote)
const { items } = await __tree.getChildren('/')
items.map(n => n.$path)

// Delete
await __tree.remove('/local/ui/theme')
```

`/local/*` paths live in browser memory only. Everything else routes through tRPC to the server.

## Playwright MCP

Claude Code can drive a browser via the `playwright` MCP server.

**Setup:** Chrome must be fully closed before launching. Playwright needs exclusive control.

```
# In Claude Code:
/mcp                          # reconnect if needed
browser_navigate localhost:3210
browser_snapshot              # accessibility tree (better than screenshot)
browser_console_messages error
browser_evaluate              # run JS in page context
```

### Testing client store via Playwright

```js
// browser_evaluate:
async () => {
  const store = window.__tree;
  await store.set({ $path: '/local/test', $type: 'test', v: 42 });
  return await store.get('/local/test');
}
```

## MCP Treenity (server-side)

The `treenity` MCP server connects directly to the running server (port 3212).

```
get_node     { path: "/" }
list_children { path: "/sys" }
set_node     { path: "/test", type: "dir" }
remove_node  { path: "/test" }
execute      { path: "/brahman", action: "chat", data: { message: "hi" } }
```

## Tests

```bash
npx tsx --test src/front/client-store.test.ts   # unified store
npx tsx --test src/front/remote-store.test.ts   # remote adapter
npx tsx --test src/store/cache.test.ts          # cache combinator
npx tsx --test                                  # all tests
```
