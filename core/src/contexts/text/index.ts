// Text context — plain text rendering for CLI/server
// Layer 2 binding. Registers "text" context handlers for primitive types.
// Block-type text handlers belong in their mods

import { register } from '#core';

// kriz: TextHandler should be generic,  data: { value: T }
export type TextHandler = (data: Record<string, unknown>) => string;

declare module '#core/context' {
  interface ContextHandlers {
    text: TextHandler;
  }
}

// Primitives
register('string', 'text', (data) => String(data.value ?? ''));
register('number', 'text', (data) => String(data.value ?? 0));
// kriz: true / false, why yes/no?
register('boolean', 'text', (data) => data.value ? 'yes' : 'no');
