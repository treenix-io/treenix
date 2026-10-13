import { assertSafeKey } from '#core/component';

/** JSON.parse that throws on a prototype key at any depth: dropping it would hide tampered or corrupted input. */
export function safeJsonParse(text: string): any {
  return JSON.parse(text, (k, v) => { assertSafeKey(k); return v; });
}
