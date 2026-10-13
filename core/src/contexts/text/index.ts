// Text context — plain text rendering for CLI/server
// Layer 2 binding. Declares "text" context handlers for primitive types.
// Block-type text handlers belong in their mods

import { normalizeType } from '#core/component';
import { declareOpenModule } from '#kernel/module-declaration';
import type { OpenRegistration } from '#kernel/types';

// kriz: TextHandler should be generic,  data: { value: T }
export type TextHandler = (data: Record<string, unknown>) => string;

export interface TextOpenRegistration extends OpenRegistration<TextHandler> {
  readonly context: 'text';
  readonly binding: 'text';
}

export function declareText(type: string, handler: TextHandler): TextOpenRegistration {
  return { type: normalizeType(type), context: 'text', binding: 'text', handler };
}

declare module '#core/context' {
  interface ContextHandlers {
    text: TextHandler;
  }
}

// Primitives
const stringText = declareText('string', (data) => String(data.value ?? ''));
const numberText = declareText('number', (data) => String(data.value ?? 0));
// kriz: true / false, why yes/no?
const booleanText = declareText('boolean', (data) => data.value ? 'yes' : 'no');
const entries = [stringText, numberText, booleanText];

export const clientModules = [declareOpenModule('@treenx/core/contexts/text', entries)];
