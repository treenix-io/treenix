// Core built-in types — registered so validation (Write-Barrier) accepts them.
// Convention: no dot = core built-in (see Type Naming Convention in CLAUDE.md)

import { normalizeType, register } from '#core';

const builtins = [
  'dir', 'root', 'ref', 'type', 'mount-point', 'session',
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
