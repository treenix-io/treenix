import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onResolveMiss, register } from '@treenx/core';
import { addTypeValidator } from '@treenx/core/comp/validate';
import type { Tree } from '@treenx/core/tree';
import { translateClass, type ClassOverride, type JsonLdSnapshot } from './translate';
import { refOrComponentValidator } from './validator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, 'packs/schemaorg-v29.json');

const EXPECTED_SHA256 = '76915a530256bc4c11bdf3be96b12120910ad2a0f59b7486c448209c097c4576';

let snapshotCache: JsonLdSnapshot | undefined;

function loadSnapshotOnce(): JsonLdSnapshot {
  if (snapshotCache) return snapshotCache;
  const raw = readFileSync(SNAPSHOT_PATH, 'utf-8');
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== EXPECTED_SHA256) {
    throw new Error(`jsonld-types: schemaorg-v29.json checksum mismatch — expected ${EXPECTED_SHA256}, got ${actual}`);
  }
  snapshotCache = JSON.parse(raw) as JsonLdSnapshot;
  return snapshotCache;
}

export function verifySnapshotChecksum(expected: string): void {
  const raw = readFileSync(SNAPSHOT_PATH, 'utf-8');
  const actual = createHash('sha256').update(raw).digest('hex');
  if (expected !== actual) {
    throw new Error(`jsonld-types: schemaorg-v29.json checksum mismatch — expected ${expected}, got ${actual}`);
  }
}

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

// missResolver is defined once at module load — stable reference for idempotent re-installs.
function missResolver(type: string): void {
  if (!type.startsWith(PREFIX)) return;
  const className = type.slice(PREFIX.length);
  const override = OVERRIDES[className];
  if (!override) return; // not in v1 pack — leave as miss for other resolvers
  // Translation errors throw loud. Pack bugs must not become silent
  // skipped validation in validate.ts:133.
  const schema = translateClass(loadSnapshotOnce(), className, override);
  register(type, 'schema', () => schema);
}

export async function loadSchemaOrgV29Pack(_tree: Tree): Promise<void> {
  loadSnapshotOnce();
  // Both calls are last-writer-wins — safe and idempotent on repeated invocation.
  addTypeValidator('jsonld.refOrComponent', refOrComponentValidator);
  // KNOWN v1 LIMITATION: onResolveMiss is singleton-per-context. This pack owns
  // 'schema' miss resolution. A future second pack (e.g., GS1, FHIR, ActivityStreams)
  // would clobber this resolver — last-writer-wins. Plan #3+ must add either:
  //   (a) a centralized 'schema' dispatcher that fans out to per-prefix sub-resolvers, or
  //   (b) a chained resolver API in core registry.
  // For v1 with a single ontology pack, last-writer-wins is acceptable.
  onResolveMiss('schema', missResolver);
}
