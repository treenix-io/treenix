import type { PropertySchema, TypeSchema } from '@treenx/core/schema/types';

// ── JSON-LD snapshot types ──

export type JsonLdRef = { '@id': string };
export type JsonLdNode = {
  '@id': string;
  '@type': string | string[];
  'rdfs:label'?: string;
  'rdfs:comment'?: string;
  'rdfs:subClassOf'?: JsonLdRef | JsonLdRef[];
  'schema:domainIncludes'?: JsonLdRef | JsonLdRef[];
  'schema:rangeIncludes'?: JsonLdRef | JsonLdRef[];
};
export type JsonLdSnapshot = {
  '@context': Record<string, string>;
  '@graph': JsonLdNode[];
};

// ── Override contract (per pack class) ──

export type FieldOverride = {
  cardinality: 'scalar' | 'array';
  slotType?: string;
};
export type ClassOverride = {
  required?: string[];
  fields: Record<string, FieldOverride>;
};

// PropertySchema extended with slotType for component slot fields
type SlottedPropertySchema = PropertySchema & { slotType?: string };

const PREFIX = 'jsonld.schema-org.';

const TEXT_RANGES = new Set([
  'schema:Text',
  'schema:URL',
  'schema:Date',
  'schema:DateTime',
  'schema:Time',
]);

function arrayify<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function findClass(snapshot: JsonLdSnapshot, className: string): JsonLdNode {
  const id = `schema:${className}`;
  for (const node of snapshot['@graph']) {
    const types = arrayify(node['@type']);
    if (node['@id'] === id && types.includes('rdfs:Class')) return node;
  }
  throw new Error(`class not found in snapshot: ${className}`);
}

function findPropertiesForClass(snapshot: JsonLdSnapshot, classId: string): JsonLdNode[] {
  const result: JsonLdNode[] = [];
  for (const node of snapshot['@graph']) {
    const types = arrayify(node['@type']);
    if (!types.includes('rdf:Property')) continue;
    const domains = arrayify(node['schema:domainIncludes']);
    if (domains.some(d => d['@id'] === classId)) result.push(node);
  }
  return result;
}

function buildScalar(field: FieldOverride, ranges: string[]): SlottedPropertySchema {
  if (field.slotType) {
    return { type: 'jsonld.refOrComponent', slotType: field.slotType };
  }
  if (ranges.some(r => TEXT_RANGES.has(r))) return { type: 'string' };
  if (ranges.some(r => r === 'schema:Number' || r === 'schema:Integer' || r === 'schema:Float')) {
    return { type: 'number' };
  }
  if (ranges.some(r => r === 'schema:Boolean')) return { type: 'boolean' };
  // unknown range — default to string (safe for curation-gated output)
  return { type: 'string' };
}

function buildFieldSchema(field: FieldOverride, propNode: JsonLdNode | undefined): SlottedPropertySchema {
  const ranges = propNode ? arrayify(propNode['schema:rangeIncludes']).map(r => r['@id']) : [];
  const scalar = buildScalar(field, ranges);
  if (field.cardinality === 'array') return { type: 'array', items: scalar };
  return scalar;
}

export function translateClass(
  snapshot: JsonLdSnapshot,
  className: string,
  overrides: ClassOverride,
): TypeSchema & { $id: string } {
  const classNode = findClass(snapshot, className); // throws on unknown class

  // Collect all properties whose domainIncludes covers this class or any ancestor
  const propsByName = new Map<string, JsonLdNode>();

  const collectProps = (classId: string) => {
    for (const propNode of findPropertiesForClass(snapshot, classId)) {
      const shortName = propNode['@id'].replace(/^schema:/, '');
      if (!propsByName.has(shortName)) propsByName.set(shortName, propNode);
    }
  };

  // Walk the subClassOf chain, collecting properties at each level
  collectProps(`schema:${className}`);
  const visited = new Set<string>([`schema:${className}`]);
  let cursor: JsonLdNode | undefined = classNode;

  while (cursor) {
    const parents = arrayify(cursor['rdfs:subClassOf']).map(p => p['@id']);
    let next: JsonLdNode | undefined;
    for (const parentId of parents) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const shortParent = parentId.replace(/^schema:/, '');
      try {
        const parentNode = findClass(snapshot, shortParent);
        collectProps(parentId);
        next = parentNode;
        break;
      } catch {
        // parent class not in snapshot — skip
      }
    }
    cursor = next;
  }

  // Build properties — only fields declared in overrides (curation contract)
  const properties: Record<string, SlottedPropertySchema> = {};
  for (const [name, fieldOverride] of Object.entries(overrides.fields)) {
    properties[name] = buildFieldSchema(fieldOverride, propsByName.get(name));
  }

  const schema: TypeSchema & { $id: string } = {
    $id: `${PREFIX}${className}`,
    type: 'object',
    properties,
  };
  if (overrides.required && overrides.required.length > 0) {
    schema.required = overrides.required;
  }
  return schema;
}
