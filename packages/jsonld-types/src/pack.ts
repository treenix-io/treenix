import { onResolveMiss, register } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { JsonSchema, ModuleManifest } from '@treenx/core/kernel/types';
import { addTypeValidator } from '@treenx/core/comp/validate';
import schemaOrgV29 from './packs/schemaorg-v29.json';
import { type ClassOverride, type JsonLdSnapshot, type SlottedPropertySchema, translateClass } from './translate';
import { refOrComponentValidator } from './validator';
import { declareClientSchema } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

// Snapshot is bundled at build time via ESM JSON import — works in Node and the browser
// without fs/crypto. Tampering protection has shifted from runtime SHA verification to
// the build/commit boundary; the file is part of the package source tree.
const SNAPSHOT = schemaOrgV29 as unknown as JsonLdSnapshot;

const OVERRIDES: Record<string, ClassOverride> = {
  Person: {
    required: ['name'],
    fields: {
      name: { cardinality: 'scalar' },
      email: { cardinality: 'scalar' },
      address: { cardinality: 'scalar', slotType: 'jsonld.schema-org.PostalAddress' },
      knows: { cardinality: 'array', slotType: 'jsonld.schema-org.Person' },
    },
  },
  Event: {
    required: ['name'],
    fields: {
      name: { cardinality: 'scalar' },
      startDate: { cardinality: 'scalar' },
    },
  },
  CreativeWork: {
    fields: {
      headline: { cardinality: 'scalar' },
      author: { cardinality: 'scalar', slotType: 'jsonld.schema-org.Person' },
    },
  },
  Article: {
    fields: {
      headline: { cardinality: 'scalar' },
      author: { cardinality: 'scalar', slotType: 'jsonld.schema-org.Person' },
    },
  },
  BlogPosting: {
    fields: {
      headline: { cardinality: 'scalar' },
      author: { cardinality: 'scalar', slotType: 'jsonld.schema-org.Person' },
    },
  },
  PostalAddress: {
    fields: {
      streetAddress: { cardinality: 'scalar' },
    },
  },
};

const PREFIX = 'jsonld.schema-org.';

export const clientModules = [declareOpenModule('@treenx/jsonld-types/schema-org-v29/defaults', [],
  Object.entries(OVERRIDES).map(([name, override]) =>
    declareClientSchema(`${PREFIX}${name}`, () => translateClass(SNAPSHOT, name, override))))];

function missResolver(type: string): void {
  if (!type.startsWith(PREFIX)) return;
  const className = type.slice(PREFIX.length);
  const override = OVERRIDES[className];
  if (!override) return;
  const schema = translateClass(SNAPSHOT, className, override);
  register(type, 'schema', () => schema);
}

/** Loads the schema.org v29 pack — registers slot validator and lazy schema resolver.
 *  Iso: works in Node (server) and browser (client). Safe to call multiple times
 *  (addTypeValidator + onResolveMiss are last-writer-wins; missResolver is a stable ref). */
export function loadSchemaOrgV29Pack(): void {
  addTypeValidator('jsonld.refOrComponent', refOrComponentValidator);
  // KNOWN v1 LIMITATION: onResolveMiss is singleton-per-context. This pack owns
  // 'schema' miss resolution. A future second pack (e.g., GS1, FHIR, ActivityStreams)
  // would clobber this resolver — last-writer-wins. Plan #3+ must add either:
  //   (a) a centralized 'schema' dispatcher that fans out to per-prefix sub-resolvers, or
  //   (b) a chained resolver API in core registry.
  onResolveMiss('schema', missResolver);
}

/** Publish slots as standard native schemas without consulting the legacy validator map. */
function nativeProperty(property: SlottedPropertySchema): JsonSchema {
  const { items, slotType, ...shape } = property;
  if (property.type === 'jsonld.refOrComponent') {
    if (slotType === undefined) throw new KernelError('INVALID', 'JSON-LD slot has no declared component type');
    return { anyOf: [
      { type: 'object', required: ['$ref'], properties: { $ref: { type: 'string' } } },
      { type: 'object', required: ['$type'], properties: { $type: { type: 'string', enum: [slotType] } } },
    ] };
  }
  return { ...shape, ...(items === undefined ? {} : { items: nativeProperty(items) }) };
}

/** Install the complete curated pack before writes; native lookup never lazily publishes mid-operation. */
export function schemaOrgV29NativeManifest(): ModuleManifest {
  const module = '@treenx/jsonld-types/schema-org-v29';
  return { id: module, security: [], open: [], types: Object.entries(OVERRIDES).map(([name, override]) => {
    const translated = translateClass(SNAPSHOT, name, override);
    return { name: `${PREFIX}${name}`, module, security: 'ordinary' as const, version: 0, actions: {},
      schema: { ...translated, properties: Object.fromEntries(Object.entries(translated.properties).map(([key, property]) => [key, nativeProperty(property)])) },
    };
  }) };
}
