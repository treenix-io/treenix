// Schema types — used by SchemaForm, NodeEditor, PageEditor

import type { ActionDef, Post, Where } from '#kernel/types';

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
  oneOf?: PropertySchema[];
  allOf?: PropertySchema[];
  additionalProperties?: boolean | PropertySchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type MethodArgSchema = { name: string } & PropertySchema;

// A9: read — called with R, runs as the caller, writes nothing; write — W and R; setuid — R, runs as the node.
export type ActionKind = ActionDef['kind'];

export type MethodSchema = {
  title?: string;
  description?: string;
  streaming?: boolean; // true if async generator — use streamAction, not execute
  arguments: MethodArgSchema[]; // at most one: TWP act carries one args value
  yields?: PropertySchema; // yield type for streaming actions
  return?: PropertySchema;
  pre?: Where; // @pre — sift query over { node, needs }, checked before the handler
  post?: Post; // @post — update operators per target: '' is the own node, other keys are needs names
  kind?: ActionKind; // @read | @write | @setuid; absent is an ordinary write action
  io?: boolean; // @io modifier — external side effect, cache-unsafe
};

export type TypeSchema = {
  $id?: string; // registry type id — set on all loaded/generated schemas
  title?: string;
  description?: string;
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties?: boolean | PropertySchema;
  methods?: Record<string, MethodSchema>;
  version?: number; // @version — stamped as $v on every component of the type; absent is version 0
  actionsOnly?: boolean; // @actionsOnly — its nodes change only through its actions; a direct commit only from admin
  aliases?: string[]; // @alias — earlier names that resolve to this type
};
