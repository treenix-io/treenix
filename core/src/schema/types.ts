// Schema types — used by SchemaForm, NodeEditor, PageEditor

export type PropertySchema = {
  type: string; // JSON Schema type or custom (e.g. "image")
  title: string;
  description?: string;
  format?: string; // JSON Schema format hint (e.g. "uri", "textarea", "integer", "timestamp")
  refType?: string; // component type name — field can hold ref or embedded value of this type
  readOnly?: boolean;
  enum?: string[]; // allowed values → renders as <select>
  items?: { type?: string; properties?: Record<string, unknown> }; // for array fields
};

export type MethodSchema = {
  title?: string;
  description?: string;
  streaming?: boolean; // true if async generator — use streamAction, not execute
  arguments: Array<{
    name: string;
    type: string;
    properties?: Record<string, Partial<PropertySchema>>;
    required?: string[];
  }>;
  yields?: { type: string }; // yield type for streaming actions
  return?: { type: string };
};

export type TypeSchema = {
  title: string;
  type: 'object';
  properties: Record<string, PropertySchema>;
  methods?: Record<string, MethodSchema>;
};
