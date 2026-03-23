## schema
JSON Schema generation and loading for registerType/defineComponent classes.

### Файлы
- extract-schemas.ts — CLI: AST walk via TypeScript compiler API → JSON Schema per class, writes to `mods/*/schemas/`
- load.ts — `loadSchemasFromDir(dir)`: reads `*.json` from dir, registers each as `register($id, 'schema', () => schema)`
- types.ts — PropertySchema, TypeSchema — shared types for SchemaForm/NodeEditor

### Конвенции
- Schemas are colocated: each mod has its own `schemas/` dir next to source
- Mod loader calls `loadSchemasFromDir()` per mod during startup
- Run `npm run schema` to regenerate after component class changes
- JSDoc on class → schema title; @format/@description on properties → schema annotations
