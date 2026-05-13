// Schema types — used by SchemaForm, NodeEditor, PageEditor

declare module '#core/context' {
  interface ContextHandlers {
    schema: () => TypeSchema;
  }
}

export type PropertySchema = {
  type?: string; // JSON Schema type or custom (e.g. "image") — absent for anyOf unions
  title?: string;
  description?: string;
  format?: string; // JSON Schema format hint (e.g. "uri", "textarea", "integer", "timestamp")
  refType?: string; // component type name — field can hold ref or embedded value of this type
  default?: unknown;
  readOnly?: boolean;
  enum?: (string | number)[]; // allowed values → renders as <select>
  enumNames?: string[]; // optional UI labels aligned with enum (for TS enum members with different names)
  items?: PropertySchema; // for array fields — recursive
  anyOf?: PropertySchema[]; // union types (e.g. string | number) — rendered as JSON fallback widget
  properties?: Record<string, PropertySchema>; // for nested object fields
  required?: string[]; // required fields within nested object
  // JSON Schema validation keywords — consumed by comp/validate.ts
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type MethodArgSchema = { name: string } & PropertySchema;

export type MethodSchema = {
  title?: string;
  description?: string;
  streaming?: boolean; // true if async generator — use streamAction, not execute
  arguments: MethodArgSchema[];
  yields?: PropertySchema; // yield type for streaming actions
  return?: PropertySchema;
  pre?: string[]; // @pre fields — Design by Contract preconditions
  post?: string[]; // @post fields — Design by Contract postconditions
  kind?: 'read' | 'write'; // @read | @write (or aliases @query | @mutation)
  io?: boolean; // @io modifier — external side effect, cache-unsafe
};

export type TypeSchema = {
  title?: string;
  description?: string;
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
  methods?: Record<string, MethodSchema>;
};
