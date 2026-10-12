import { rawFsMimeTypes } from '#kernel/store/rawfs-codec';
import type { TypeDef } from '#kernel/types';

export const rawFsMountType: TypeDef = {
  name: 't.mount.rawfs',
  module: 'kernel',
  security: 'privileged-capability',
  version: 0,
  actions: {},
  schema: {
    type: 'object',
    required: ['pattern', 'directory'],
    additionalProperties: false,
    properties: {
      pattern: { type: 'string' },
      directory: { type: 'string', minLength: 1 },
      external: { enum: ['none', 'trusted'] },
    },
  },
};

export const rawFsTypes: readonly TypeDef[] = [
  rawFsMountType,
  ...rawFsMimeTypes.map(
    (mime): TypeDef => ({
      name: mime,
      module: 'kernel',
      security: 'ordinary',
      version: 0,
      schema: { type: 'object', properties: {} },
      actions: {},
    }),
  ),
];
