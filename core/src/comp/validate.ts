// Component validation — shared between client and server
// Type-dispatched validator tree: type check → dispatch → type-specific constraints + recurse
// kriz: this should be somewhere near schema!! not in comp!

import { AnyType, type ComponentData, getComponents, isCompKey, type NodeData } from '#core';
import { resolve, resolveExact } from '#core/registry';
import { KernelError } from '#errors';
import type { PropertySchema, TypeSchema } from '#schema/types';
import { createBoundedCache } from '#util/bounded-cache';
import { isRecord } from '#util/is-record';

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidateOptions = {
  /** A component whose type has no schema registered for it throws UNKNOWN_TYPE instead of being skipped. */
  strict?: boolean;
};

// ── Schema cost guard ──

// Caps the worst offenders against the validator: catastrophic-backtracking regex
// (length + nested-quantifier shape) and deeply nested schemas.
const SCHEMA_PATTERN_MAX = 256;
const SCHEMA_DEPTH_MAX = 16;
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*]/;

function assertSafePattern(pattern: string, ctx: string): void {
  if (pattern.length > SCHEMA_PATTERN_MAX) throw new KernelError('INVALID', `${ctx}: schema.pattern too long (>${SCHEMA_PATTERN_MAX})`);
  // The classic catastrophic-backtracking shape: nested quantifiers like (a+)+ / (a*)*.
  if (NESTED_QUANTIFIER.test(pattern)) throw new KernelError('INVALID', `${ctx}: schema.pattern has nested quantifiers (ReDoS risk)`);
}

/** Walks a schema that arrives as data (a stored type node) before anything validates against it. */
export function assertSafeSchema(schema: unknown, ctx: string, depth = 0): void {
  if (!schema || typeof schema !== 'object') return;
  if (depth > SCHEMA_DEPTH_MAX) throw new KernelError('INVALID', `${ctx}: schema too deep (max ${SCHEMA_DEPTH_MAX})`);
  if (Array.isArray(schema)) { for (const v of schema) assertSafeSchema(v, ctx, depth + 1); return; }
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'pattern' && typeof v === 'string') compiledPattern(v, ctx);
    assertSafeSchema(v, ctx, depth + 1);
  }
}

// Code-registered schemas never pass assertSafeSchema, so every pattern is checked on its first
// compile. Patterns come from schemas and are few; the bound only stops edited stored schemas from piling up.
const compiledPatterns = createBoundedCache<string, RegExp>(1024);

function compiledPattern(pattern: string, path: string): RegExp {
  const cached = compiledPatterns.get(pattern);
  if (cached) return cached;

  assertSafePattern(pattern, path);
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new KernelError('INVALID', `${path}: schema.pattern is not a valid regex (${String(e)})`);
  }

  compiledPatterns.set(pattern, re);
  return re;
}

// ── Type-dispatched validator tree ──

export type TypeValidator = (value: unknown, def: PropertySchema, path: string, errors: ValidationError[]) => void;

const validateNumber: TypeValidator = (value, def, path, errors) => {
  if (typeof value !== 'number') { errors.push({ path, message: `expected number, got ${typeof value}` }); return; }
  if (typeof def.minimum === 'number' && value < def.minimum)
    errors.push({ path, message: `minimum ${def.minimum}, got ${value}` });
  if (typeof def.maximum === 'number' && value > def.maximum)
    errors.push({ path, message: `maximum ${def.maximum}, got ${value}` });
};

const builtinValidators: Record<string, TypeValidator> = {
  string(value, def, path, errors) {
    if (typeof value !== 'string') { errors.push({ path, message: `expected string, got ${typeof value}` }); return; }
    if (typeof def.minLength === 'number' && value.length < def.minLength)
      errors.push({ path, message: `min length ${def.minLength}, got ${value.length}` });
    if (typeof def.maxLength === 'number' && value.length > def.maxLength)
      errors.push({ path, message: `max length ${def.maxLength}, got ${value.length}` });
    if (typeof def.pattern === 'string' && !compiledPattern(def.pattern, path).test(value))
      errors.push({ path, message: `must match /${def.pattern}/` });
  },

  number: validateNumber,

  integer(value, def, path, errors) {
    validateNumber(value, def, path, errors);
    if (typeof value === 'number' && !Number.isInteger(value)) errors.push({ path, message: `expected integer, got ${value}` });
  },

  boolean(value, _def, path, errors) {
    if (typeof value !== 'boolean') errors.push({ path, message: `expected boolean, got ${typeof value}` });
  },

  null(value, _def, path, errors) {
    if (value !== null) errors.push({ path, message: `expected null, got ${typeof value}` });
  },

  array(value, def, path, errors) {
    if (!Array.isArray(value)) { errors.push({ path, message: `expected array, got ${typeof value}` }); return; }
    if (typeof def.minItems === 'number' && value.length < def.minItems)
      errors.push({ path, message: `min items ${def.minItems}, got ${value.length}` });
    if (typeof def.maxItems === 'number' && value.length > def.maxItems)
      errors.push({ path, message: `max items ${def.maxItems}, got ${value.length}` });

    if (!def.items) return;
    // Typeless items with properties are object items.
    const items: PropertySchema = def.items.type === undefined && def.items.properties
      ? { ...def.items, type: 'object' }
      : def.items;

    for (let i = 0; i < value.length; i++) {
      const ip = `${path}[${i}]`;

      // Fix K: null/undefined in array fails against item type — not silently skipped.
      // (Was: continue on null. Hid malformed arrays like [null, null] passing object schema.)
      if (value[i] === undefined || value[i] === null) {
        errors.push({ path: ip, message: `expected ${items.type ?? 'value'}, got ${value[i] === null ? 'null' : 'undefined'}` });
        continue;
      }

      validateValue(value[i], items, ip, errors);
    }
  },

  object(value, def, path, errors) {
    if (!isRecord(value)) {
      errors.push({ path, message: `expected object, got ${Array.isArray(value) ? 'array' : typeof value}` });
      return;
    }
    validateFields(value, def, path, errors, anyKey);
  },
};

// A Map, so a schema `type` naming an Object.prototype member ('toString', '__proto__') finds no validator.
const typeValidators = new Map(Object.entries(builtinValidators));

// ── Extension point ──

export function addTypeValidator(type: string, fn: TypeValidator): void {
  typeValidators.set(type, fn);
}

// ── Core ──

// Every keyword present applies: `type` dispatches, anyOf/oneOf/allOf compose over the same value.
export function validateValue(value: unknown, def: PropertySchema, path: string, errors: ValidationError[]): void {
  if (def.type) typeValidators.get(def.type)?.(value, def, path, errors);

  if (def.enum && !def.enum.some(allowed => allowed === value))
    errors.push({ path, message: `must be one of: ${def.enum.join(', ')}` });

  if (def.anyOf && !def.anyOf.some(branch => matches(value, branch, path)))
    errors.push({ path, message: `must match at least one of ${def.anyOf.length} anyOf schemas` });

  if (def.oneOf) {
    const matched = def.oneOf.filter(branch => matches(value, branch, path)).length;
    if (matched !== 1) errors.push({ path, message: `must match exactly one of ${def.oneOf.length} oneOf schemas, matched ${matched}` });
  }

  if (def.allOf) for (const branch of def.allOf) validateValue(value, branch, path, errors);
}

function matches(value: unknown, def: PropertySchema, path: string): boolean {
  const errors: ValidationError[] = [];
  validateValue(value, def, path, errors);
  return errors.length === 0;
}

type ObjectSchema = Pick<PropertySchema, 'properties' | 'required' | 'additionalProperties'>;

const anyKey = (_key: string) => true;

// A component's own fields: `$` keys are system, `#` keys are the node's named components (D3).
const isOwnField = (key: string) => !key.startsWith('$') && !isCompKey(key);

const admitsNull = (properties: Record<string, PropertySchema>, key: string, path: string) =>
  Object.hasOwn(properties, key) && matches(null, properties[key], path);

// null counts as absent in an optional field. A required field may hold null only when its own
// schema admits null — the extractor lists `T | null` fields as required with anyOf [T, {}].
function validateFields(
  obj: Record<string, unknown>,
  def: ObjectSchema,
  basePath: string,
  errors: ValidationError[],
  ownField: (key: string) => boolean,
): void {
  const at = (key: string) => basePath ? `${basePath}.${key}` : key;
  const properties = def.properties ?? {};

  for (const key of def.required ?? []) {
    const val = obj[key];
    if (val === undefined || (val === null && !admitsNull(properties, key, at(key))))
      errors.push({ path: at(key), message: `required field missing` });
  }

  for (const [prop, propDef] of Object.entries(properties)) {
    const val = obj[prop];
    if (val === undefined || val === null) continue;
    validateValue(val, propDef, at(prop), errors);
  }

  const extra = def.additionalProperties;
  if (extra === undefined || extra === true) return;

  for (const [key, val] of Object.entries(obj)) {
    if (Object.hasOwn(properties, key) || !ownField(key) || val === undefined || val === null) continue;
    if (extra === false) errors.push({ path: at(key), message: `unexpected field` });
    else validateValue(val, extra, at(key), errors);
  }
}

export function validateComponent(comp: ComponentData, schema: TypeSchema, field: string): ValidationError[] {
  const errors: ValidationError[] = [];
  validateFields(comp, schema, field || comp.$type, errors, isOwnField);
  return errors;
}

// Strict takes the type's own registered schema: it never falls back to `default` and never fires
// a miss resolver (D4). A schema a miss resolver already registered on an earlier non-strict lookup
// does count, so a lazily registered pack must publish eagerly before strict can guard its types.
export function validateNode(node: NodeData, opts?: ValidateOptions): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [name, comp] of getComponents(node, AnyType)) {
    const schema = opts?.strict ? resolveExact(comp.$type, 'schema')?.() : resolve(comp.$type, 'schema')?.();

    if (!schema) {
      if (opts?.strict) throw new KernelError('UNKNOWN_TYPE', `${node.$path} ${name || 'main component'}: no schema for type "${comp.$type}"`);
      continue;
    }

    errors.push(...validateComponent(comp, schema, name));
  }

  return errors;
}
