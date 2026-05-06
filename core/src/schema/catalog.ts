// TypeCatalog — pure registry-based type discovery
// No tree deps, only core registry. Usable from MCP, services, LLM, tests.

import { getRegisteredTypes, resolve } from '#core';
import type { MethodSchema, PropertySchema, TypeSchema } from '#schema/types';

export type CatalogPropertyDoc = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  refType?: string;
  required?: boolean;
};

export type CatalogActionDoc = {
  title?: string;
  description?: string;
  streaming?: boolean;
  arguments?: string[];
};

export type CatalogEntry = {
  name: string;
  title?: string;
  description?: string;
  properties: string[];
  actions: string[];
  propertyDocs?: Record<string, CatalogPropertyDoc>;
  actionDocs?: Record<string, CatalogActionDoc>;
};

export type TypeDescription = {
  name: string;
  title?: string;
  description?: string;
  properties: Record<string, unknown>;
  methods?: Record<string, unknown>;
  references?: string[];
  referencedBy?: string[];
};

function getSchema(typeName: string): TypeSchema | null {
  return (resolve(typeName, 'schema') as (() => TypeSchema) | null)?.() ?? null;
}

function inferType(prop: PropertySchema): string | undefined {
  if (prop.type) return prop.type;
  if (prop.anyOf?.length) return prop.anyOf.map((p) => p.type ?? 'unknown').join('|');
  return undefined;
}

function summarizeProperty(
  name: string,
  prop: PropertySchema,
  required: Set<string>,
): CatalogPropertyDoc | null {
  const doc: CatalogPropertyDoc = {};
  const type = inferType(prop);

  if (type) doc.type = type;
  if (prop.title) doc.title = prop.title;
  if (prop.description) doc.description = prop.description;
  if (prop.format) doc.format = prop.format;
  if (prop.refType) doc.refType = prop.refType;
  if (required.has(name)) doc.required = true;

  return Object.keys(doc).length ? doc : null;
}

function summarizeAction(method: MethodSchema): CatalogActionDoc | null {
  const doc: CatalogActionDoc = {};

  if (method.title) doc.title = method.title;
  if (method.description) doc.description = method.description;
  if (method.streaming) doc.streaming = true;
  if (method.arguments?.length) {
    doc.arguments = method.arguments.map((arg) => {
      const type = inferType(arg);
      return type ? `${arg.name}: ${type}` : arg.name;
    });
  }

  return Object.keys(doc).length ? doc : null;
}

function catalogEntry(name: string, schema: TypeSchema | null): CatalogEntry {
  const properties = Object.keys(schema?.properties ?? {});
  const actions = Object.keys(schema?.methods ?? {});
  const required = new Set(schema?.required ?? []);
  const propertyDocs: Record<string, CatalogPropertyDoc> = {};
  const actionDocs: Record<string, CatalogActionDoc> = {};

  for (const [propName, prop] of Object.entries(schema?.properties ?? {})) {
    const doc = summarizeProperty(propName, prop, required);
    if (doc) propertyDocs[propName] = doc;
  }

  for (const [actionName, method] of Object.entries(schema?.methods ?? {})) {
    const doc = summarizeAction(method);
    if (doc) actionDocs[actionName] = doc;
  }

  return {
    name,
    ...(schema?.title ? { title: schema.title } : {}),
    ...(schema?.description && schema.description !== schema.title
      ? { description: schema.description }
      : {}),
    properties,
    actions,
    ...(Object.keys(propertyDocs).length ? { propertyDocs } : {}),
    ...(Object.keys(actionDocs).length ? { actionDocs } : {}),
  };
}

export class TypeCatalog {
  /** List all registered types with compact type, property, and action docs */
  list(): CatalogEntry[] {
    return getRegisteredTypes('schema').map((name) => {
      return catalogEntry(name, getSchema(name));
    });
  }

  /** Full schema + bidirectional cross-references */
  describe(typeName: string): TypeDescription | null {
    const schema = getSchema(typeName);
    if (!schema) return null;

    const references: string[] = [];
    const referencedBy: string[] = [];

    for (const [, prop] of Object.entries(schema.properties ?? {}) as [string, any][]) {
      if (prop.refType && !references.includes(prop.refType)) references.push(prop.refType);
    }

    for (const otherName of getRegisteredTypes('schema')) {
      if (otherName === typeName) continue;
      const other = getSchema(otherName);
      if (!other?.properties) continue;

      for (const [, prop] of Object.entries(other.properties) as [string, any][]) {
        if (prop.refType === typeName) {
          referencedBy.push(otherName);
          break;
        }
      }
    }

    return {
      name: typeName,
      ...schema,
      ...(references.length ? { references } : {}),
      ...(referencedBy.length ? { referencedBy } : {}),
    };
  }

  /** Search types by keyword across names, titles, props, actions, action args */
  search(query: string): CatalogEntry[] {
    const q = query.toLowerCase();
    const matches: CatalogEntry[] = [];

    for (const name of getRegisteredTypes('schema')) {
      const schema = getSchema(name);
      const methods = Object.entries(schema?.methods ?? {}) as [string, any][];
      const props = Object.entries(schema?.properties ?? {}) as [string, any][];
      const haystack = [
        name,
        schema?.title ?? '',
        schema?.description ?? '',
        ...props.flatMap(([k, v]) => [
          k,
          v.title ?? '',
          v.description ?? '',
          v.format ?? '',
          v.refType ?? '',
        ]),
        ...methods.flatMap(([k, m]) => [
          k,
          m.title ?? '',
          m.description ?? '',
          ...(m.arguments ?? []).flatMap((a: any) => [
            a.name ?? '',
            ...Object.keys(a.properties ?? {}),
            ...Object.values(a.properties ?? {}).map((p: any) => p.description ?? ''),
          ]),
        ]),
      ].join(' ').toLowerCase();

      if (haystack.includes(q)) {
        matches.push(catalogEntry(name, schema));
      }
    }

    return matches;
  }
}
