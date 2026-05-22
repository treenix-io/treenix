## comp
Component registration layer (L2). Bridges core primitives and server.

### Files
- index.ts — registerType, findCompByType, Actions<T>, TypeProxy<T> = Raw<T> & Actions<T>
- needs.ts — sibling dependency injection: registerNeeds/resolveNeeds
- handle.ts — typed client/server action proxy helpers
- validate.ts — schema-backed component and argument validation

### Conventions
- registerType auto-registers prototype methods as action:{name}
- Components never access siblings directly — use `needs` for injection
- ExecCtx = {node, tree, signal, nc, deps} — context during action execution
