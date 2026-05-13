## schema
JSON Schema generation and loading for registerType/defineComponent classes.

### Files
- extract-schemas-oxc.ts — CLI + API: AST walk via OXC (Rust) → JSON Schema per class, writes to `schemas/` dirs. Supports `@hidden`, `@format`, `@refType`, `@pre/@post`
- load.ts — `loadSchemasFromDir(dir)`: reads `*.json` from dir, registers each as `register($id, 'schema', () => schema)`
- types.ts — PropertySchema, TypeSchema — shared types for SchemaForm/NodeEditor

### Conventions
- Schemas are colocated: each mod has its own `schemas/` dir next to source
- Mod loader calls `loadSchemasFromDir()` per mod during startup
- Schemas auto-generate on dev server startup; `npm run schema` for CI or to regenerate without restarting
- JSDoc on class → schema title; @format/@description on properties → schema annotations
