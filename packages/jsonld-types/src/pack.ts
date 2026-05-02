import { onResolveMiss, register } from '@treenx/core';
import { addTypeValidator } from '@treenx/core/comp/validate';
import schemaOrgV29 from './packs/schemaorg-v29.json';
import { type ClassOverride, type JsonLdSnapshot, translateClass } from './translate';
import { refOrComponentValidator } from './validator';

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
