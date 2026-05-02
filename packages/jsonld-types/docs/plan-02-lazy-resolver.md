# JSON-LD Pack — Lazy Schema Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a new workspace package `@treenx/jsonld-types` that loads a vendored schema.org JSON-LD subset and exposes its types as Treenix types via lazy registration. After loading, `tree.set({ $type: 'jsonld.schema-org.Person', $path: '/p', name: 'Alice' })` validates against a generated `TypeSchema` produced on first resolve.

**Architecture:**
1. **Vendored snapshot** — small JSON-LD fixture (5 classes, ~15 properties) committed to repo with SHA-256 verification. v1 covers `Person, Event, CreativeWork, Article, BlogPosting` + parent `Thing`. Full schema.org (~800 classes) is for later — we ship a subset that proves the pattern.
2. **Translator** — pure function `translateClass(snapshot, className, overrides) → TypeSchema`. Walks JSON-LD `@graph`, collects properties whose `schema:domainIncludes` includes the target class, narrows to validator-supported subset (string/number/boolean/array/object/refOrComponent). Per-class overrides drive cardinality, required, and slot mapping.
3. **`refOrComponent` custom validator** — registered via existing `addTypeValidator('jsonld.refOrComponent', ...)` ([engine/core/src/comp/validate.ts:91](engine/core/src/comp/validate.ts#L91)). Accepts either a Treenix ref (`{$ref, $type?}`) or a typed component matching the declared `slotType`.
4. **Pack init** — `loadSchemaOrgV29Pack(tree)` does three things, all idempotent:
   - Verifies SHA-256 of the vendored snapshot (loud throw on mismatch)
   - Calls `addTypeValidator('jsonld.refOrComponent', refOrComponentValidator)` once
   - Calls `onResolveMiss('schema', resolver)` where the resolver, on miss for `jsonld.schema-org.<X>`, calls `translateClass(...)` and `register(type, 'schema', () => schema)`. First miss parses; subsequent resolves hit silent-dedup memoization.
5. **Validation flow** — relies on the registry sync-miss re-check fix from [previous plan's Phase 0](./2026-05-01-jsonld-types-core-foundations.md): when `validateNode` calls `resolve(type, 'schema')` for a never-seen pack type, the miss-resolver registers the schema synchronously and the same `resolve()` call returns the new handler. Validation proceeds in the same `tree.set` call — no second-call delay, no silent skip.

**Tech Stack:** TypeScript strict, ESM, `node:test` runner via `npm test`. Zero deps beyond `@treenx/core`. SHA-256 via Node's built-in `node:crypto`.

**Spec:** This plan implements ACs 7, 9, 10, 11, 12, 13, 19, 20, 21 from [AUTO_REVIEW_JSONLD_TYPES.md](../../AUTO_REVIEW_JSONLD_TYPES.md). Specifically:
- AC7: snapshot SHA-256 mismatch fails loud at startup
- AC9–12: scalar/array/object validation rejects type mismatches and missing required
- AC13: pack-load asserts no `anyOf` in any v1 schema
- AC19: slot field rejects malformed objects, accepts ref or typed component
- AC20: pack idempotency (running pack-load twice doesn't duplicate or double-parse)
- AC21: `validateNode` enforces validation on first `set` for a never-resolved pack type

**Out of scope:** mount adapter at `/sys/types/jsonld/` (Plan #3), inheritance walker (Plan #4), JSON-LD round-trip exporter/importer (Plan #5), `mods/ontology` migration (Plan #6).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `engine/packages/jsonld-types/package.json` | Create | Workspace package manifest, name `@treenx/jsonld-types`, `imports#*` for `src/`, `exports.` |
| `engine/packages/jsonld-types/tsconfig.json` | Create | Extends root config, strict, ESM |
| `engine/packages/jsonld-types/src/index.ts` | Create | Public barrel: re-export `loadSchemaOrgV29Pack` |
| `engine/packages/jsonld-types/src/packs/schemaorg-v29.json` | Create | Vendored JSON-LD fixture (5 classes + parent + properties) |
| `engine/packages/jsonld-types/src/translate.ts` | Create | RDF class → TypeSchema (validator-supported subset only) |
| `engine/packages/jsonld-types/src/translate.test.ts` | Create | Translator unit tests (cardinality, required, scalar, array, slot) |
| `engine/packages/jsonld-types/src/validator.ts` | Create | `refOrComponentValidator` for `addTypeValidator` |
| `engine/packages/jsonld-types/src/validator.test.ts` | Create | Validator unit tests (ref, typed component, malformed reject) |
| `engine/packages/jsonld-types/src/pack.ts` | Create | `loadSchemaOrgV29Pack`, SHA-256 verify, miss-resolver wiring, per-class overrides |
| `engine/packages/jsonld-types/src/pack.test.ts` | Create | Pack init tests + end-to-end `tree.set + validateNode` integration |
| `engine/package.json` (root) | Modify (add `engine/packages/jsonld-types` to workspaces if needed) | Workspace registration |
| `tsconfig.base.json` (root) | Modify (add path alias if needed for cross-package import) | Optional — only if root TypeScript needs to see the package |

---

## Task 1: Workspace package skeleton

**Files:**
- Create: `engine/packages/jsonld-types/package.json`
- Create: `engine/packages/jsonld-types/tsconfig.json`
- Create: `engine/packages/jsonld-types/src/index.ts` (placeholder)

- [ ] **Step 1: Create package.json**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/package.json`:

```json
{
  "name": "@treenx/jsonld-types",
  "version": "0.1.0",
  "description": "JSON-LD vocabulary type packs for Treenix — schema.org subset as native types via lazy resolver.",
  "type": "module",
  "private": true,
  "license": "FSL-1.1-MIT",
  "imports": {
    "#*": {
      "development": "./src/*.ts",
      "default": "./dist/*.js"
    }
  },
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "dependencies": {
    "@treenx/core": "workspace:*"
  },
  "scripts": {
    "test": "node --test --conditions development 'src/**/*.test.ts'"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

If `engine/tsconfig.base.json` does not exist, run `ls /Users/kriz/dev/t/core/engine/` and `ls /Users/kriz/dev/t/core/engine/packages/react/tsconfig.json` to find the right base. Adapt the `extends` path. The exact path is whatever the existing `engine/packages/react/tsconfig.json` uses.

- [ ] **Step 3: Create placeholder src/index.ts**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/index.ts`:

```ts
// @treenx/jsonld-types — public surface. Real exports added in later tasks.
export {};
```

- [ ] **Step 4: Confirm typecheck passes for the new package**

From project root `/Users/kriz/dev/t/core`:

```bash
npx tsc -p engine/packages/jsonld-types --noEmit
```

Expected: zero errors. Empty package compiles.

- [ ] **Step 5: Commit**

```bash
cd /Users/kriz/dev/t/core/engine && git add packages/jsonld-types/ && git commit -m "feat(jsonld-types): workspace package skeleton"
```

---

## Task 2: Vendored JSON-LD fixture (5 classes + properties)

**Files:**
- Create: `engine/packages/jsonld-types/src/packs/schemaorg-v29.json`

This fixture is a hand-curated minimal subset of schema.org v29 vocabulary. It is NOT the full vocabulary. v1 ships this small set because it exercises every translator code path (scalar string, scalar number, array of refs, slot component, required field) and proves the pattern. Larger packs come later.

- [ ] **Step 1: Create the fixture**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/packs/schemaorg-v29.json` with exactly this content:

```json
{
  "@context": {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "schema": "https://schema.org/"
  },
  "@graph": [
    {
      "@id": "schema:Thing",
      "@type": "rdfs:Class",
      "rdfs:label": "Thing",
      "rdfs:comment": "The most generic type of item."
    },
    {
      "@id": "schema:Person",
      "@type": "rdfs:Class",
      "rdfs:subClassOf": { "@id": "schema:Thing" },
      "rdfs:label": "Person"
    },
    {
      "@id": "schema:Event",
      "@type": "rdfs:Class",
      "rdfs:subClassOf": { "@id": "schema:Thing" },
      "rdfs:label": "Event"
    },
    {
      "@id": "schema:CreativeWork",
      "@type": "rdfs:Class",
      "rdfs:subClassOf": { "@id": "schema:Thing" },
      "rdfs:label": "CreativeWork"
    },
    {
      "@id": "schema:Article",
      "@type": "rdfs:Class",
      "rdfs:subClassOf": { "@id": "schema:CreativeWork" },
      "rdfs:label": "Article"
    },
    {
      "@id": "schema:BlogPosting",
      "@type": "rdfs:Class",
      "rdfs:subClassOf": { "@id": "schema:Article" },
      "rdfs:label": "BlogPosting"
    },
    {
      "@id": "schema:PostalAddress",
      "@type": "rdfs:Class",
      "rdfs:subClassOf": { "@id": "schema:Thing" },
      "rdfs:label": "PostalAddress"
    },
    {
      "@id": "schema:name",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:Thing" }],
      "schema:rangeIncludes": [{ "@id": "schema:Text" }]
    },
    {
      "@id": "schema:email",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:Person" }],
      "schema:rangeIncludes": [{ "@id": "schema:Text" }]
    },
    {
      "@id": "schema:address",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:Person" }],
      "schema:rangeIncludes": [{ "@id": "schema:PostalAddress" }, { "@id": "schema:Text" }]
    },
    {
      "@id": "schema:knows",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:Person" }],
      "schema:rangeIncludes": [{ "@id": "schema:Person" }]
    },
    {
      "@id": "schema:startDate",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:Event" }],
      "schema:rangeIncludes": [{ "@id": "schema:Date" }]
    },
    {
      "@id": "schema:headline",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:CreativeWork" }],
      "schema:rangeIncludes": [{ "@id": "schema:Text" }]
    },
    {
      "@id": "schema:author",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:CreativeWork" }],
      "schema:rangeIncludes": [{ "@id": "schema:Person" }]
    },
    {
      "@id": "schema:streetAddress",
      "@type": "rdf:Property",
      "schema:domainIncludes": [{ "@id": "schema:PostalAddress" }],
      "schema:rangeIncludes": [{ "@id": "schema:Text" }]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/kriz/dev/t/core/engine && git add packages/jsonld-types/src/packs/schemaorg-v29.json && git commit -m "feat(jsonld-types): vendor schemaorg v29 fixture (5 classes + props)"
```

---

## Task 3: Translator failing tests

**Files:**
- Create: `engine/packages/jsonld-types/src/translate.test.ts`

The translator converts a JSON-LD class definition into a Treenix `TypeSchema`. Inputs: the parsed snapshot, a class short-name (e.g. `'Person'`), an overrides map. Output: a `TypeSchema` with `properties` populated only for fields specified in overrides — this enforces curation: fields not in overrides are dropped (RDF descriptive properties may include 100s of irrelevant ones; the override file is the contract).

- [ ] **Step 1: Write the failing tests**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/translate.test.ts` with this exact content:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { translateClass, type ClassOverride, type JsonLdSnapshot } from './translate';

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
    // schema:email and schema:address exist in fixture's domainIncludes for Person,
    // but overrides only declare 'name' → email/address must NOT appear.
    assert.equal(schema.properties?.email, undefined);
    assert.equal(schema.properties?.address, undefined);
  });

  it('throws on unknown class name', () => {
    assert.throws(
      () => translateClass(SNAPSHOT, 'NonexistentClass', { fields: {} }),
      /class not found.*NonexistentClass/i,
    );
  });

  it('asserts no anyOf appears in any v1 schema (AC13)', () => {
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsc -p engine/packages/jsonld-types --noEmit
```

Expected: TypeScript errors on missing `./translate` module / missing exports `translateClass`, `ClassOverride`, `JsonLdSnapshot`. That's the point — implementation in next task.

- [ ] **Step 3: Commit failing tests**

```bash
cd /Users/kriz/dev/t/core/engine && git add packages/jsonld-types/src/translate.test.ts && git commit -m "test(jsonld-types): failing translator tests (cardinality, slots, AC13)"
```

---

## Task 4: Translator implementation

**Files:**
- Create: `engine/packages/jsonld-types/src/translate.ts`

- [ ] **Step 1: Create the translator**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/translate.ts` with this exact content:

```ts
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
  slotType?: string; // declares this field as a component slot of the given Treenix type
};
export type ClassOverride = {
  required?: string[];
  fields: Record<string, FieldOverride>;
};

// ── Type prefix (one per pack vocabulary) ──

const PREFIX = 'jsonld.schema-org.';

// ── RDF text range → JSON Schema scalar type ──
// schema:Text → string; schema:Number → number; schema:Boolean → boolean;
// schema:Date / schema:DateTime → string (no Date type in JSON Schema draft-07)
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
    if (node['@id'] === id && (node['@type'] === 'rdfs:Class' || (Array.isArray(node['@type']) && node['@type'].includes('rdfs:Class')))) {
      return node;
    }
  }
  throw new Error(`class not found in snapshot: ${className}`);
}

// Given a class id, return all property nodes whose schema:domainIncludes lists it.
// (We do not walk subClassOf for inherited properties — overrides are explicit per class.)
function findPropertiesForClass(snapshot: JsonLdSnapshot, classId: string): JsonLdNode[] {
  const result: JsonLdNode[] = [];
  for (const node of snapshot['@graph']) {
    const types = arrayify(node['@type']);
    if (!types.includes('rdf:Property')) continue;
    const domains = arrayify(node['schema:domainIncludes']);
    if (domains.some(d => d['@id'] === classId)) {
      result.push(node);
    }
  }
  return result;
}

function buildScalarSchema(field: FieldOverride, propRanges: string[]): PropertySchema {
  if (field.slotType) {
    return { type: 'jsonld.refOrComponent', slotType: field.slotType } as unknown as PropertySchema;
  }
  // Pick the first text-like range. RDF allows multiple ranges; we narrow to one
  // dominant range during pack curation. If none of the ranges are recognized
  // primitives, default to 'string' — pack overrides should set slotType for
  // entity ranges instead of letting them fall through here.
  if (propRanges.some(r => TEXT_RANGES.has(r))) return { type: 'string' };
  if (propRanges.some(r => r === 'schema:Number' || r === 'schema:Integer' || r === 'schema:Float')) return { type: 'number' };
  if (propRanges.some(r => r === 'schema:Boolean')) return { type: 'boolean' };
  return { type: 'string' };
}

function buildFieldSchema(field: FieldOverride, propNode: JsonLdNode | undefined): PropertySchema {
  const ranges = propNode ? arrayify(propNode['schema:rangeIncludes']).map(r => r['@id']) : [];
  const scalar = buildScalarSchema(field, ranges);
  if (field.cardinality === 'array') {
    return { type: 'array', items: scalar };
  }
  return scalar;
}

export function translateClass(
  snapshot: JsonLdSnapshot,
  className: string,
  overrides: ClassOverride,
): TypeSchema {
  findClass(snapshot, className); // throws if not found
  const classId = `schema:${className}`;
  const propsByName = new Map<string, JsonLdNode>();
  for (const propNode of findPropertiesForClass(snapshot, classId)) {
    const shortName = propNode['@id'].replace(/^schema:/, '');
    propsByName.set(shortName, propNode);
  }
  // Properties may be inherited via subClassOf — walk parents and collect their
  // domain properties too so overrides can reference them.
  const visited = new Set<string>([classId]);
  let cursor = findClass(snapshot, className);
  while (true) {
    const parents = arrayify(cursor['rdfs:subClassOf']).map(p => p['@id']);
    let advanced = false;
    for (const parentId of parents) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const shortParent = parentId.replace(/^schema:/, '');
      let parentNode: JsonLdNode | undefined;
      try { parentNode = findClass(snapshot, shortParent); } catch { continue; }
      for (const propNode of findPropertiesForClass(snapshot, parentId)) {
        const shortName = propNode['@id'].replace(/^schema:/, '');
        if (!propsByName.has(shortName)) propsByName.set(shortName, propNode);
      }
      cursor = parentNode;
      advanced = true;
      break;
    }
    if (!advanced) break;
  }

  const properties: Record<string, PropertySchema> = {};
  for (const [name, fieldOverride] of Object.entries(overrides.fields)) {
    const propNode = propsByName.get(name); // may be undefined; treat as bare scalar
    properties[name] = buildFieldSchema(fieldOverride, propNode);
  }

  const schema: TypeSchema = {
    $id: `${PREFIX}${className}`,
    type: 'object',
    properties,
  };
  if (overrides.required && overrides.required.length > 0) {
    schema.required = overrides.required;
  }
  return schema;
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npm test --workspace=@treenx/jsonld-types -- --test-name-pattern="translateClass"
```

If `npm test --workspace` syntax is not configured for the new package, run from inside the package dir:

```bash
cd /Users/kriz/dev/t/core/engine/packages/jsonld-types && npx tsx --test --conditions development src/translate.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/kriz/dev/t/core && npx tsc -p engine/packages/jsonld-types --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/kriz/dev/t/core/engine && git add packages/jsonld-types/src/translate.ts && git commit -m "feat(jsonld-types): RDF class → TypeSchema translator"
```

---

## Task 5: refOrComponent validator — failing tests + impl

**Files:**
- Create: `engine/packages/jsonld-types/src/validator.ts`
- Create: `engine/packages/jsonld-types/src/validator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/validator.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refOrComponentValidator } from './validator';
import type { ValidationError } from '@treenx/core/comp/validate';
import type { PropertySchema } from '@treenx/core/schema/types';

const slotDef = { type: 'jsonld.refOrComponent', slotType: 'jsonld.schema-org.PostalAddress' } as unknown as PropertySchema;

function validate(value: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  refOrComponentValidator(value, slotDef as any, 'address', errors);
  return errors;
}

describe('refOrComponentValidator', () => {
  it('accepts a Treenix ref shape', () => {
    const errors = validate({ $ref: '/customers/alice' });
    assert.equal(errors.length, 0);
  });

  it('accepts a Treenix ref with $type=ref', () => {
    const errors = validate({ $type: 'ref', $ref: '/customers/alice' });
    assert.equal(errors.length, 0);
  });

  it('accepts a typed component matching the slot type', () => {
    const errors = validate({ $type: 'jsonld.schema-org.PostalAddress', streetAddress: '1 Way' });
    assert.equal(errors.length, 0);
  });

  it('rejects an object whose $type is not the slot type', () => {
    const errors = validate({ $type: 'jsonld.schema-org.Person', name: 'Bob' });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /expected jsonld\.schema-org\.PostalAddress/);
  });

  it('rejects an object with neither $ref nor matching $type (garbage shape)', () => {
    const errors = validate({ garbage: true });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /expected.*PostalAddress|untyped/);
  });

  it('rejects a non-object value (string)', () => {
    const errors = validate('a string');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /expected ref or typed component/);
  });

  it('rejects a non-object value (number)', () => {
    const errors = validate(42);
    assert.equal(errors.length, 1);
  });

  it('rejects null', () => {
    const errors = validate(null);
    assert.equal(errors.length, 1);
  });

  it('flags a pack bug if slotType is missing on the schema definition', () => {
    const badDef = { type: 'jsonld.refOrComponent' } as unknown as PropertySchema;
    const errors: ValidationError[] = [];
    refOrComponentValidator({ $type: 'jsonld.schema-org.PostalAddress' }, badDef as any, 'address', errors);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /slotType/);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /Users/kriz/dev/t/core/engine/packages/jsonld-types && npx tsx --test --conditions development src/validator.test.ts
```

Expected: FAIL — `validator.ts` does not exist yet.

- [ ] **Step 3: Implement the validator**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/validator.ts`:

```ts
import { isRef } from '@treenx/core';
import type { TypeValidator } from '@treenx/core/comp/validate';

/** Validates a slot field declared as `{ type: 'jsonld.refOrComponent', slotType: '...' }`.
 *  Accepts: a Treenix ref ({$ref, $type?}) OR a typed component whose $type equals slotType.
 *  Rejects: non-objects, null, objects with neither $ref nor matching $type, schema bugs
 *  (slotType missing from definition). */
export const refOrComponentValidator: TypeValidator = (value, def, path, errors) => {
  if (value == null || typeof value !== 'object') {
    errors.push({ path, message: `expected ref or typed component, got ${value === null ? 'null' : typeof value}` });
    return;
  }
  if (isRef(value)) return; // ref shape — accepted

  const slotType = (def as { slotType?: string }).slotType;
  if (!slotType) {
    errors.push({ path, message: 'slot field missing slotType in schema definition (pack bug)' });
    return;
  }

  const valueType = (value as { $type?: unknown }).$type;
  if (valueType !== slotType) {
    errors.push({
      path,
      message: `expected ${slotType}, got ${typeof valueType === 'string' ? valueType : 'untyped object'}`,
    });
  }
};
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /Users/kriz/dev/t/core/engine/packages/jsonld-types && npx tsx --test --conditions development src/validator.test.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/kriz/dev/t/core/engine && git add packages/jsonld-types/src/validator.ts packages/jsonld-types/src/validator.test.ts && git commit -m "feat(jsonld-types): refOrComponent slot validator"
```

---

## Task 6: Pack init — failing test (lazy registration via onResolveMiss)

**Files:**
- Create: `engine/packages/jsonld-types/src/pack.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/pack.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  getRegisteredTypes,
  mapRegistry,
  onResolveMiss,
  resolve,
  unregister,
} from '@treenx/core';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { loadSchemaOrgV29Pack } from './pack';

let savedRegistry: Array<[string, string]> = [];

function snapshotRegistry(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  mapRegistry((t, c) => { out.push([t, c]); });
  return out;
}

function restoreRegistryTo(snap: Array<[string, string]>) {
  const current = snapshotRegistry();
  const wanted = new Set(snap.map(([t, c]) => `${t}@${c}`));
  for (const [t, c] of current) {
    if (!wanted.has(`${t}@${c}`)) unregister(t, c);
  }
}

describe('loadSchemaOrgV29Pack', () => {
  let tree: Tree;

  beforeEach(() => {
    savedRegistry = snapshotRegistry();
    tree = createMemoryTree();
  });

  afterEach(() => {
    onResolveMiss('schema', () => {}); // reset 'schema' miss resolver to noop
    restoreRegistryTo(savedRegistry);
  });

  it('registers no pack schemas eagerly (lazy contract)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const types = getRegisteredTypes('schema');
    assert.equal(types.includes('jsonld.schema-org.Person'), false, 'Person must NOT be registered yet — only on resolve');
    assert.equal(types.includes('jsonld.schema-org.Event'), false);
  });

  it('registers a pack schema on first resolve(type, schema) (AC21 path)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const handler = resolve('jsonld.schema-org.Person', 'schema');
    assert.ok(handler, 'sync miss resolver must return handler in same call');
    const schema = (handler as () => unknown)();
    assert.equal((schema as { $id: string }).$id, 'jsonld.schema-org.Person');
    assert.ok(getRegisteredTypes('schema').includes('jsonld.schema-org.Person'));
  });

  it('memoizes — second resolve does not re-parse', async () => {
    await loadSchemaOrgV29Pack(tree);
    const first = resolve('jsonld.schema-org.Person', 'schema');
    const second = resolve('jsonld.schema-org.Person', 'schema');
    assert.equal(first, second, 'same handler reference on memoized resolve');
  });

  it('returns null for non-pack types (prefix mismatch)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const handler = resolve('some.other.type', 'schema');
    assert.equal(handler, null);
  });

  it('idempotent — running pack-load twice does not duplicate registry entries (AC20)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const before = snapshotRegistry();
    await loadSchemaOrgV29Pack(tree);
    const after = snapshotRegistry();
    assert.equal(after.length, before.length, 'registry size unchanged after second load');
  });

  it('throws loud on snapshot SHA-256 mismatch (AC7)', async () => {
    // Cannot easily mutate the on-disk snapshot in-memory for this test.
    // Instead, temporarily import the pack with a tampered checksum constant.
    // Implementation should expose checksum verification as a separate function we can test.
    const { verifySnapshotChecksum } = await import('./pack');
    assert.throws(
      () => verifySnapshotChecksum('not-the-real-sha256'),
      /checksum mismatch/i,
    );
  });
});

describe('end-to-end: validateNode through pack resolver', () => {
  let savedRegistry: Array<[string, string]>;

  beforeEach(() => { savedRegistry = snapshotRegistry(); });
  afterEach(() => { onResolveMiss('schema', () => {}); restoreRegistryTo(savedRegistry); });

  it('first tree.set of a never-resolved pack type validates via lazy resolver (AC21)', async () => {
    const { validateNode } = await import('@treenx/core/comp/validate');
    const tree = createMemoryTree();
    await loadSchemaOrgV29Pack(tree);

    const validNode = {
      $path: '/customers/alice',
      $type: 'jsonld.schema-org.Person',
      name: 'Alice',
    } as any;
    const errors = validateNode(validNode);
    assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
  });

  it('rejects scalar type mismatch (AC9)', async () => {
    const { validateNode } = await import('@treenx/core/comp/validate');
    const tree = createMemoryTree();
    await loadSchemaOrgV29Pack(tree);

    const errors = validateNode({
      $path: '/customers/alice',
      $type: 'jsonld.schema-org.Person',
      name: 42,
    } as any);
    assert.equal(errors.length > 0, true, 'name=42 must error (string expected)');
  });

  it('rejects missing required (AC12)', async () => {
    const { validateNode } = await import('@treenx/core/comp/validate');
    const tree = createMemoryTree();
    await loadSchemaOrgV29Pack(tree);

    const errors = validateNode({
      $path: '/customers/alice',
      $type: 'jsonld.schema-org.Person',
    } as any);
    assert.equal(errors.length > 0, true, 'missing name must error');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /Users/kriz/dev/t/core/engine/packages/jsonld-types && npx tsx --test --conditions development src/pack.test.ts
```

Expected: FAIL — `pack.ts` does not exist; no `loadSchemaOrgV29Pack` export.

- [ ] **Step 3: Commit failing tests**

```bash
cd /Users/kriz/dev/t/core/engine && git add packages/jsonld-types/src/pack.test.ts && git commit -m "test(jsonld-types): failing pack tests (lazy resolver, idempotency, e2e validate)"
```

---

## Task 7: Pack init implementation

**Files:**
- Create: `engine/packages/jsonld-types/src/pack.ts`
- Modify: `engine/packages/jsonld-types/src/index.ts` (export pack init)

- [ ] **Step 1: Implement pack init**

Create `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/pack.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onResolveMiss, register } from '@treenx/core';
import { addTypeValidator } from '@treenx/core/comp/validate';
import type { Tree } from '@treenx/core/tree';
import { translateClass, type ClassOverride, type JsonLdSnapshot } from './translate';
import { refOrComponentValidator } from './validator';

// ── Vendored snapshot — loaded once ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, 'packs/schemaorg-v29.json');

// SHA-256 of packs/schemaorg-v29.json as committed. If the file is tampered
// with at runtime the loader fails loud. Update only via an explicit pack
// refresh command (Plan #5+).
const EXPECTED_SHA256 = '__FILL_IN_AT_TASK_8__';

let snapshotCache: JsonLdSnapshot | undefined;

function loadSnapshotOnce(): JsonLdSnapshot {
  if (snapshotCache) return snapshotCache;
  const raw = readFileSync(SNAPSHOT_PATH, 'utf-8');
  verifySnapshotChecksum(undefined, raw);
  snapshotCache = JSON.parse(raw) as JsonLdSnapshot;
  return snapshotCache;
}

export function verifySnapshotChecksum(expected?: string, contentOverride?: string): void {
  const content = contentOverride ?? readFileSync(SNAPSHOT_PATH, 'utf-8');
  const actual = createHash('sha256').update(content).digest('hex');
  const wanted = expected ?? EXPECTED_SHA256;
  if (wanted !== actual) {
    throw new Error(`jsonld-types: schemaorg-v29.json checksum mismatch — expected ${wanted}, got ${actual}`);
  }
}

// ── Per-class overrides for v1 ──
// Each entry curates which RDF properties become Treenix fields, their cardinality,
// scalar vs slot, and required. Properties absent from `fields` are dropped.

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

// ── Pack init — idempotent ──

const PREFIX = 'jsonld.schema-org.';
let validatorRegistered = false;
let resolverRegistered = false;

export async function loadSchemaOrgV29Pack(_tree: Tree): Promise<void> {
  loadSnapshotOnce(); // verifies checksum + caches snapshot

  if (!validatorRegistered) {
    addTypeValidator('jsonld.refOrComponent', refOrComponentValidator);
    validatorRegistered = true;
  }

  if (!resolverRegistered) {
    onResolveMiss('schema', (type) => {
      if (!type.startsWith(PREFIX)) return;
      const className = type.slice(PREFIX.length);
      const override = OVERRIDES[className];
      if (!override) return; // unknown class — leave as miss
      const snapshot = loadSnapshotOnce();
      let schema;
      try { schema = translateClass(snapshot, className, override); }
      catch (e) {
        // Translation failure is loud — caller's resolve will return null,
        // and validateNode skips. Logging makes the failure visible in dev.
        console.error(`[jsonld-types] failed to translate ${className}:`, e);
        return;
      }
      register(type, 'schema', () => schema);
    });
    resolverRegistered = true;
  }
}
```

- [ ] **Step 2: Update index.ts**

Replace the contents of `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/index.ts` with:

```ts
export { loadSchemaOrgV29Pack, verifySnapshotChecksum } from './pack';
export type { ClassOverride, FieldOverride, JsonLdSnapshot } from './translate';
```

- [ ] **Step 3: Compute the actual snapshot SHA-256 and pin it**

Run from project root:

```bash
shasum -a 256 /Users/kriz/dev/t/core/engine/packages/jsonld-types/src/packs/schemaorg-v29.json | awk '{print $1}'
```

Expected: a 64-character hex string. Copy it.

In `/Users/kriz/dev/t/core/engine/packages/jsonld-types/src/pack.ts`, replace `__FILL_IN_AT_TASK_8__` with the actual SHA-256.

- [ ] **Step 4: Run pack tests — verify they pass**

```bash
cd /Users/kriz/dev/t/core/engine/packages/jsonld-types && npx tsx --test --conditions development src/pack.test.ts
```

Expected: all 9 tests PASS (6 in `loadSchemaOrgV29Pack` describe + 3 in `end-to-end`).

If the `verifySnapshotChecksum('not-the-real-sha256')` test fails because EXPECTED_SHA256 happens to match the test's bad input (impossibly improbable), that's a sentinel failure — change `'not-the-real-sha256'` in the test to a different obviously-invalid string.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/kriz/dev/t/core && npx tsc -p engine/packages/jsonld-types --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/kriz/dev/t/core/engine && git add packages/jsonld-types/src/pack.ts packages/jsonld-types/src/index.ts && git commit -m "feat(jsonld-types): lazy schema resolver + sha256 verify + overrides"
```

---

## Task 8: Final verification — typecheck + full project test run

**Files:** none modified.

- [ ] **Step 1: Typecheck the three tsconfigs (project level)**

```bash
cd /Users/kriz/dev/t/core && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 2: Full test run**

```bash
cd /Users/kriz/dev/t/core && npm test
```

Expected: all suites green; the new `loadSchemaOrgV29Pack` and `end-to-end` describe blocks should appear.

- [ ] **Step 3: Confirm git log shows the expected commits**

```bash
cd /Users/kriz/dev/t/core/engine && git log --oneline -10
```

Expected most-recent-first:
1. `feat(jsonld-types): lazy schema resolver + sha256 verify + overrides`
2. `test(jsonld-types): failing pack tests (lazy resolver, idempotency, e2e validate)`
3. `feat(jsonld-types): refOrComponent slot validator`
4. `feat(jsonld-types): RDF class → TypeSchema translator`
5. `test(jsonld-types): failing translator tests (cardinality, slots, AC13)`
6. `feat(jsonld-types): vendor schemaorg v29 fixture (5 classes + props)`
7. `feat(jsonld-types): workspace package skeleton`

- [ ] **Step 4: No commit — verification only**

This task does not create a commit. If verification reveals an issue, fix inline before declaring done.

---

## Acceptance criteria coverage

| AC | Task |
|---|---|
| AC7 — snapshot SHA-256 mismatch fails loud | Task 7 (`verifySnapshotChecksum` test) |
| AC9 — scalar type mismatch rejected | Task 6 e2e (`name: 42`) |
| AC10 — scalar-vs-array mismatch rejected | not exhaustively tested in v1; Plan #4+ exercises with array slot fixture |
| AC11 — object/scalar mismatch rejected | Task 5 (refOrComponentValidator rejects strings/numbers) |
| AC12 — missing required rejected | Task 6 e2e (no `name` field) |
| AC13 — no `anyOf` in any v1 schema | Task 3 translator test (`assert no anyOf in any v1 schema`) |
| AC19 — slot field rejects malformed objects, accepts ref/typed | Task 5 |
| AC20 — pack idempotency | Task 6 (`loadSchemaOrgV29Pack` twice → registry size unchanged) |
| AC21 — `validateNode` enforces validation on first set for never-resolved type | Task 6 e2e (relies on Plan #1's sync-miss fix) |

## What this plan deliberately does NOT cover

- `t.mount.jsonld` mount adapter for `/sys/types/jsonld/...` browseability — Plan #3.
- UIX inheritance walker (`tree.get` → parent → resolveExact) — Plan #4.
- Round-trip JSON-LD exporter/importer — Plan #5.
- `mods/ontology/` migration to use pack types — Plan #6.
- ActivityStreams / GS1 / FHIR packs — out of v1 scope.

These are intentionally deferred so this PR is reviewable: ~1,000 LoC of net-new code in a brand-new package; no behavioural change for any existing caller.
