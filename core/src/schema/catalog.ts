// TypeCatalog — pure registry-based type discovery
// No store deps, only core registry. Usable from MCP, services, LLM, tests.

import { getRegisteredTypes, resolve } from '#core';

export type CatalogEntry = {
  name: string;
  title?: string;
  properties: string[];
  actions: string[];
};

export type TypeDescription = {
  name: string;
  title?: string;
  properties: Record<string, unknown>;
  methods?: Record<string, unknown>;
  references: string[];
  referencedBy: string[];
};

export class TypeCatalog {
  /** List all registered types with title, property names, action names */
  list(): CatalogEntry[] {
    return getRegisteredTypes('schema').map(name => {
      const schema = (resolve(name, 'schema') as any)?.();
      return {
        name,
        title: schema?.title,
        properties: Object.keys(schema?.properties ?? {}),
        actions: Object.keys(schema?.methods ?? {}),
      };
    });
  }

  /** Full schema + bidirectional cross-references */
  describe(typeName: string): TypeDescription | null {
    const schema = (resolve(typeName, 'schema') as any)?.();
    if (!schema) return null;

    const references: string[] = [];
    const referencedBy: string[] = [];

    for (const [, prop] of Object.entries(schema.properties ?? {}) as [string, any][]) {
      if (prop.refType && !references.includes(prop.refType)) references.push(prop.refType);
    }

    for (const otherName of getRegisteredTypes('schema')) {
      if (otherName === typeName) continue;
      const other = (resolve(otherName, 'schema') as any)?.();
      if (!other?.properties) continue;
      for (const [, prop] of Object.entries(other.properties) as [string, any][]) {
        if (prop.refType === typeName) { referencedBy.push(otherName); break; }
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
      const schema = (resolve(name, 'schema') as any)?.();
      const methods = Object.entries(schema?.methods ?? {}) as [string, any][];
      const props = Object.entries(schema?.properties ?? {}) as [string, any][];
      const haystack = [
        name,
        schema?.title ?? '',
        schema?.description ?? '',
        ...props.flatMap(([k, v]) => [k, v.title ?? '', v.description ?? '', v.format ?? '', v.refType ?? '']),
        ...methods.flatMap(([k, m]) => [
          k, m.title ?? '', m.description ?? '',
          ...(m.arguments ?? []).flatMap((a: any) => [
            a.name ?? '',
            ...Object.keys(a.properties ?? {}),
            ...Object.values(a.properties ?? {}).map((p: any) => p.description ?? ''),
          ]),
        ]),
      ].join(' ').toLowerCase();

      if (haystack.includes(q)) {
        matches.push({
          name,
          title: schema?.title,
          properties: Object.keys(schema?.properties ?? {}),
          actions: Object.keys(schema?.methods ?? {}),
        });
      }
    }

    return matches;
  }
}
