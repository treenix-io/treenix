import { isRef } from '@treenx/core';
import type { TypeValidator } from '@treenx/core/comp/validate';

/** Validates a slot field declared as `{ type: 'jsonld.refOrComponent', slotType: '...' }`.
 *  Accepts: Treenix ref ({$ref}) OR typed component whose $type equals slotType.
 *  Rejects: non-objects, null, wrong $type, garbage shapes, missing slotType (pack bug). */
export const refOrComponentValidator: TypeValidator = (value, def, path, errors) => {
  if (value == null || typeof value !== 'object') {
    errors.push({ path, message: `expected ref or typed component, got ${value === null ? 'null' : typeof value}` });
    return;
  }

  if (isRef(value)) return;

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
