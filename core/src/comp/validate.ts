// Component validation — shared between client and server
// Type-dispatched validator tree: type check → dispatch → type-specific constraints + recurse

import { AnyType, type ComponentData, getComponents, type NodeData } from '#core';
import { resolve } from '#core/registry';
import type { PropertySchema, TypeSchema } from '#schema/types';

export type ValidationError = {
  path: string;
  message: string;
};

// ── Type-dispatched validator tree ──

export type TypeValidator = (value: unknown, def: PropertySchema, path: string, errors: ValidationError[]) => void;

const typeValidators: Record<string, TypeValidator> = {
  string(value, def, path, errors) {
    if (typeof value !== 'string') { errors.push({ path, message: `expected string, got ${typeof value}` }); return; }
    if (typeof def.minLength === 'number' && value.length < def.minLength)
      errors.push({ path, message: `min length ${def.minLength}, got ${value.length}` });
    if (typeof def.maxLength === 'number' && value.length > def.maxLength)
      errors.push({ path, message: `max length ${def.maxLength}, got ${value.length}` });
    if (typeof def.pattern === 'string' && !new RegExp(def.pattern).test(value))
      errors.push({ path, message: `must match /${def.pattern}/` });
    if (def.enum && !def.enum.includes(value))
      errors.push({ path, message: `must be one of: ${def.enum.join(', ')}` });
  },

  number(value, def, path, errors) {
    if (typeof value !== 'number') { errors.push({ path, message: `expected number, got ${typeof value}` }); return; }
    if (typeof def.minimum === 'number' && value < def.minimum)
      errors.push({ path, message: `minimum ${def.minimum}, got ${value}` });
    if (typeof def.maximum === 'number' && value > def.maximum)
      errors.push({ path, message: `maximum ${def.maximum}, got ${value}` });
  },

  boolean(value, _def, path, errors) {
    if (typeof value !== 'boolean') errors.push({ path, message: `expected boolean, got ${typeof value}` });
  },

  array(value, def, path, errors) {
    if (!Array.isArray(value)) { errors.push({ path, message: `expected array, got ${typeof value}` }); return; }
    if (typeof def.minItems === 'number' && value.length < def.minItems)
      errors.push({ path, message: `min items ${def.minItems}, got ${value.length}` });
    if (typeof def.maxItems === 'number' && value.length > def.maxItems)
      errors.push({ path, message: `max items ${def.maxItems}, got ${value.length}` });

    if (!def.items) return;
    const items = def.items;

    for (let i = 0; i < value.length; i++) {
      const ip = `${path}[${i}]`;

      // Fix K: null/undefined in array fails against item type — not silently skipped.
      // (Was: continue on null. Hid malformed arrays like [null, null] passing object schema.)
      if (value[i] === undefined || value[i] === null) {
        errors.push({ path: ip, message: `expected ${items.type ?? 'value'}, got ${value[i] === null ? 'null' : 'undefined'}` });
        continue;
      }

      if (items.properties) {
        if (typeof value[i] !== 'object') {
          errors.push({ path: ip, message: `expected object, got ${typeof value[i]}` });
        } else {
          validateObject(value[i] as Record<string, unknown>, items.properties, ip, errors);
        }
      } else if (items.type) {
        validateValue(value[i], items, ip, errors);
      }
    }
  },

  object(value, def, path, errors) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push({ path, message: `expected object, got ${Array.isArray(value) ? 'array' : typeof value}` });
      return;
    }
    if (def.required) {
      const obj = value as Record<string, unknown>;
      for (const key of def.required) {
        if (obj[key] === undefined) {
          errors.push({ path: path ? `${path}.${key}` : key, message: `required field missing` });
        }
      }
    }
    if (def.properties) validateObject(value as Record<string, unknown>, def.properties, path, errors);
  },
};

// ── Extension point ──

export function addTypeValidator(type: string, fn: TypeValidator): void {
  typeValidators[type] = fn;
}

// ── Core ──

export function validateValue(value: unknown, def: PropertySchema, path: string, errors: ValidationError[]): void {
  if (!def.type) return;
  const validator = typeValidators[def.type];
  if (validator) validator(value, def, path, errors);
}

function validateObject(obj: Record<string, unknown>, properties: Record<string, PropertySchema>, basePath: string, errors: ValidationError[]): void {
  for (const [prop, propDef] of Object.entries(properties)) {
    const val = obj[prop];
    if (val === undefined || val === null) continue;
    validateValue(val, propDef, basePath ? `${basePath}.${prop}` : prop, errors);
  }
}

export function validateComponent(comp: ComponentData, schema: TypeSchema, field: string): ValidationError[] {
  if (!schema.properties) return [];
  const errors: ValidationError[] = [];
  const basePath = field || comp.$type;

  if (schema.required) {
    const obj = comp as unknown as Record<string, unknown>;
    for (const key of schema.required) {
      if (obj[key] === undefined) {
        errors.push({ path: basePath ? `${basePath}.${key}` : key, message: `required field missing` });
      }
    }
  }

  validateObject(comp as unknown as Record<string, unknown>, schema.properties, basePath, errors);
  return errors;
}

export function validateNode(node: NodeData): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [name, comp] of getComponents(node, AnyType)) {
    const schemaHandler = resolve(comp.$type, 'schema');
    if (!schemaHandler) continue;

    const schema = (schemaHandler as () => TypeSchema)();
    if (!schema?.properties) continue;

    errors.push(...validateComponent(comp, schema, name));
  }

  return errors;
}
