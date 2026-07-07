// Core built-in types — registered so validation (Write-Barrier) accepts them.
// Convention: no dot = core built-in (see Type Naming Convention in CLAUDE.md)

import { normalizeType, register } from '#core';

// kriz: should be 't.dir', 't.root', and so on
// kriz: should be revised and reviewed
const builtins = [
  'dir', 'root', 'ref', 'moved', 'type', 'mount-point', 'session',
];

export function registerBuiltins() {
  for (const type of builtins) {
    register(type, 'schema', () => ({
      $id: normalizeType(type),
      type: 'object' as const,
      title: type,
      properties: {},
    }));
  }
}

registerBuiltins();
