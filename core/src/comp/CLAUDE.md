## comp
Component registration layer (L2). Bridges core primitives and server.

### Файлы
- index.ts — registerType, findCompByType, Actions<T>, TypeProxy<T> = Raw<T> & Actions<T>
- needs.ts — sibling dependency injection: registerNeeds/resolveNeeds
- ports.ts — action port graph: pre/post conditions as queryable edges
- planner.ts — backward+forward chaining planner on the port graph

### Конвенции
- registerType auto-registers all public methods as action:{name}
- Components never access siblings directly — use `needs` for injection
- Ports declared via static metadata, planner resolves execution order
- ExecCtx = {node, tree, signal, nc, deps} — context during action execution
