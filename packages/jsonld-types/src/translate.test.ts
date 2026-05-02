import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { translateClass, type ClassOverride, type JsonLdSnapshot } from './translate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT: JsonLdSnapshot = JSON.parse(
  readFileSync(join(__dirname, 'packs/schemaorg-v29.json'), 'utf-8'),
);

describe('translateClass', () => {
  it('emits scalar string for Text-ranged property with cardinality scalar', () => {
    const overrides: ClassOverride = {
      required: ['name'],
      fields: { name: { cardinality: 'scalar' } },
    };
    const schema = translateClass(SNAPSHOT, 'Person', overrides);
    assert.equal(schema.$id, 'jsonld.schema-org.Person');
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.properties?.name, { type: 'string' });
    assert.deepEqual(schema.required, ['name']);
  });

  it('emits array of strings for Text-ranged property with cardinality array', () => {
    const overrides: ClassOverride = {
      fields: { email: { cardinality: 'array' } },
    };
    const schema = translateClass(SNAPSHOT, 'Person', overrides);
    assert.deepEqual(schema.properties?.email, { type: 'array', items: { type: 'string' } });
  });

  it('emits jsonld.refOrComponent for slot field with explicit slotType', () => {
    const overrides: ClassOverride = {
      fields: {
        address: { cardinality: 'scalar', slotType: 'jsonld.schema-org.PostalAddress' },
      },
    };
    const schema = translateClass(SNAPSHOT, 'Person', overrides);
    assert.deepEqual(schema.properties?.address, {
      type: 'jsonld.refOrComponent',
      slotType: 'jsonld.schema-org.PostalAddress',
    });
  });

  it('emits array of refOrComponent for array slot field', () => {
    const overrides: ClassOverride = {
      fields: {
        knows: { cardinality: 'array', slotType: 'jsonld.schema-org.Person' },
      },
    };
    const schema = translateClass(SNAPSHOT, 'Person', overrides);
    assert.deepEqual(schema.properties?.knows, {
      type: 'array',
      items: { type: 'jsonld.refOrComponent', slotType: 'jsonld.schema-org.Person' },
    });
  });

  it('drops fields not present in overrides (curation contract)', () => {
    const overrides: ClassOverride = {
      fields: { name: { cardinality: 'scalar' } },
    };
    const schema = translateClass(SNAPSHOT, 'Person', overrides);
    assert.equal(schema.properties?.email, undefined);
    assert.equal(schema.properties?.address, undefined);
  });

  it('throws on unknown class name', () => {
    assert.throws(
      () => translateClass(SNAPSHOT, 'NonexistentClass', { fields: {} }),
      /class not found.*NonexistentClass/i,
    );
  });

  it('asserts no anyOf/oneOf in any v1 schema (AC13)', () => {
    const v1Classes: Array<[string, ClassOverride]> = [
      ['Person', { required: ['name'], fields: { name: { cardinality: 'scalar' } } }],
      ['Event', { required: ['name'], fields: { name: { cardinality: 'scalar' } } }],
      ['CreativeWork', { fields: { headline: { cardinality: 'scalar' } } }],
      ['Article', { fields: { headline: { cardinality: 'scalar' } } }],
      ['BlogPosting', { fields: { headline: { cardinality: 'scalar' } } }],
    ];
    for (const [cls, ov] of v1Classes) {
      const schema = translateClass(SNAPSHOT, cls, ov);
      const json = JSON.stringify(schema);
      assert.equal(json.includes('anyOf'), false, `${cls} schema must not contain anyOf`);
      assert.equal(json.includes('oneOf'), false, `${cls} schema must not contain oneOf`);
    }
  });

  it('walks ALL rdfs:subClassOf parents (BFS, not just first)', () => {
    // Manufacture a snapshot with multiple inheritance:
    //   X subClassOf [A, B]; A has prop 'fromA'; B has prop 'fromB'
    // The translator must collect properties from BOTH A and B.
    const synth: JsonLdSnapshot = {
      '@context': { rdfs: 'http://www.w3.org/2000/01/rdf-schema#', schema: 'https://schema.org/' },
      '@graph': [
        { '@id': 'schema:A', '@type': 'rdfs:Class', 'rdfs:label': 'A' },
        { '@id': 'schema:B', '@type': 'rdfs:Class', 'rdfs:label': 'B' },
        {
          '@id': 'schema:X',
          '@type': 'rdfs:Class',
          'rdfs:label': 'X',
          'rdfs:subClassOf': [{ '@id': 'schema:A' }, { '@id': 'schema:B' }],
        },
        { '@id': 'schema:fromA', '@type': 'rdf:Property', 'schema:domainIncludes': [{ '@id': 'schema:A' }], 'schema:rangeIncludes': [{ '@id': 'schema:Text' }] },
        { '@id': 'schema:fromB', '@type': 'rdf:Property', 'schema:domainIncludes': [{ '@id': 'schema:B' }], 'schema:rangeIncludes': [{ '@id': 'schema:Text' }] },
      ],
    } as unknown as JsonLdSnapshot;

    const schema = translateClass(synth, 'X', {
      fields: {
        fromA: { cardinality: 'scalar' },
        fromB: { cardinality: 'scalar' },
      },
    });
    assert.deepEqual(schema.properties?.fromA, { type: 'string' });
    assert.deepEqual(schema.properties?.fromB, { type: 'string' });
  });

  it('throws when override field has no matching snapshot property and no slotType', () => {
    assert.throws(
      () => translateClass(SNAPSHOT, 'Person', {
        fields: { knosw: { cardinality: 'scalar' } }, // typo: 'knosw' instead of 'knows'
      }),
      /not found in snapshot.*knosw/i,
    );
  });

  it('does NOT throw when override field has slotType (slot is self-declared)', () => {
    // A slot field can name a Treenix type that has no schema.org snapshot entry
    const schema = translateClass(SNAPSHOT, 'Person', {
      fields: {
        myCustomLink: { cardinality: 'scalar', slotType: 'jsonld.schema-org.Person' },
      },
    });
    assert.deepEqual(schema.properties?.myCustomLink, {
      type: 'jsonld.refOrComponent',
      slotType: 'jsonld.schema-org.Person',
    });
  });
});
