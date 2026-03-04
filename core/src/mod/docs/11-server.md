# 11 — Server: tRPC, MCP, Seed

## Seed

`seed(store)` — идемпотентно создаёт системные ноды:
- `/sys`, `/sys/autostart`
- `/auth`, `/auth/users`, `/auth/sessions`
- `/mnt/orders`, `/entities`, `/orders`

## MCP Server

Инструменты (без ACL):

```ts
get_node(path)                      // → NodeData | undefined
list_children(path, depth?)         // → Page<NodeData>
set_node(path, type, components?)   // read-merge-write → NodeData
remove_node(path)                   // → boolean
execute(path, action, component?, data?)  // → result
```

## tRPC Router — все endpoints

### Чтение
```ts
get({ path, watch? })                                    // → NodeData | undefined
getChildren({ path, limit?, offset?, watch?, watchNew? }) // → Page<NodeData>
```

### Запись
```ts
set({ node })                                    // → void
setComponent({ path, name, data, rev? })         // → void
remove({ path })                                 // → boolean
```

### Экшены
```ts
execute({ path, type?, key?, action, data? })     // → result
streamAction({ path, type?, key?, action, data? }) // → AsyncIterable (subscription)
```

### Шаблоны
```ts
getTemplates()                                   // → NodeData[]
applyTemplate({ templatePath, targetPath })      // → { applied, blocks }
```

### Аутентификация
```ts
register({ userId, password })   // → { token, userId }
login({ userId, password })      // → { token, userId }
anonLogin()                      // → { token, userId }
me()                             // → { userId } | null
```

### Watch
```ts
unwatch({ paths })               // отписаться от exact-path
unwatchChildren({ paths })       // отписаться от prefix-watch
events                           // SSE поток NodeEvent
```
