## schema
JSON Schema generation and loading for registerComp/defineComponent classes.

### Файлы
- extract-schemas.ts — CLI: AST walk via TypeScript compiler API → JSON Schema per class, writes to generated/
- load.ts — loadSchemas(): reads generated/*.json, registers each as register($id, 'schema', () => schema)
- types.ts — PropertySchema, TypeSchema — shared types for SchemaForm/NodeEditor
- generated/ — auto-generated JSON schemas (git-ignored, run extract-schemas.ts to rebuild)

### Конвенции
- Run `tsx src/schema/extract-schemas.ts` to regenerate after component class changes
- JSDoc on class → schema title; @format/@description on properties → schema annotations
- load.ts auto-executes on import (call loadSchemas() or just import the file)
