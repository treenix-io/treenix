import { normalizeType } from '#core/component'
import { A, DEFAULT_LIMITS, R, W, type ModuleManifest, type TypeDef } from '#kernel/types'

export const optionalKernelTypes: readonly TypeDef[] = [{
  name: 't.mount.memory', module: 'kernel', security: 'user-capability', version: 0, actions: {},
  schema: { type: 'object', required: ['pattern'], additionalProperties: false,
    properties: { pattern: { type: 'string' }, external: { enum: ['none', 'trusted'] } } },
}]

export const kernelManifest: ModuleManifest = {
  id: 'kernel',
  types: [...['dir', 'root', 'ref', 'mount-point'].map(type => ({
    name: normalizeType(type), module: 'kernel', security: 'ordinary', version: 0,
    schema: { type: 'object', properties: {} }, actions: {},
  } as const)), ...optionalKernelTypes, {
    name: 't.type', module: 'kernel', security: 'ordinary', version: 0, actions: {}, actionsOnly: true,
    schema: { type: 'object', required: ['name', 'module', 'security'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1 }, module: { type: 'string', minLength: 1 },
        security: { enum: ['ordinary', 'user-capability', 'privileged-capability'] } } },
  }, {
    name: 't.limits', module: 'kernel', security: 'ordinary', version: 0, actions: {}, actionsOnly: true,
    schema: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(name => [name, { type: 'number', minimum: 0 }])) },
  }],
  security: ['t.type', 't.limits'].map(type => ({ type, context: 'acl', handler: input => input.admin ? R | W | A : R })),
  open: [],
}
