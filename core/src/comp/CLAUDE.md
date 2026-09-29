## comp
Component registration layer (L2). Bridges core primitives and server.

### Files
- index.ts — registerType, findCompByType, Actions<T>, TypeProxy<T> = Raw<T> & Actions<T>
- needs.ts — sibling dependency injection: registerNeeds/resolveNeeds
- handle.ts — typed client/server action proxy helpers
- validate.ts — the schema engine: component and argument validation, strict unknown-type rejection, schema cost guard (assertSafeSchema)

### Conventions
- registerType auto-registers prototype methods as action:{name}
- Components could access siblings directly — but better use `needs` for injection
- ExecCtx = {node, tree, signal, nc, deps} — context during action execution
