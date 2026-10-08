// Core built-in types — registered so validation (Write-Barrier) accepts them.
// Convention: no dot = core built-in (see Type Naming Convention in CLAUDE.md)

import { normalizeType } from './component';
import { registerLegacy } from './registry';
import type { ModuleManifest } from '#kernel/types';

// kriz: should be 't.dir', 't.root', and so on
// kriz: should be revised and reviewed
const builtins = [
  'dir', 'root', 'ref', 'moved', 'type', 'mount-point', 'session',
];

export function registerBuiltins() {
  for (const type of builtins) {
    registerLegacy(type, 'schema', () => ({
      $id: normalizeType(type),
      type: 'object' as const,
      title: type,
      properties: {},
    }));
  }
}

registerBuiltins();

export const kernelManifest: ModuleManifest = {
  id: 'kernel',
  types: ['dir', 'root', 'ref', 'type', 'mount-point'].map(type => ({
    name: normalizeType(type), module: 'kernel', security: 'ordinary', version: 0,
    schema: { type: 'object', properties: {} }, actions: {},
  })),
  security: [], open: [],
};
