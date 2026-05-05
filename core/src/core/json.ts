// Prototype-pollution defense for object keys + JSON parsing.

export function isSafeKey(name: string): boolean {
  return name !== '__proto__' && name !== 'constructor' && name !== 'prototype';
}

export function assertSafeKey(name: string) {
  if (!isSafeKey(name)) throw new Error(`Forbidden prototype key: ${name}`);
}

const TYPE_NAME_RE = /^[a-z][a-z0-9./_+-]*$/i;
export function assertValidType(type: unknown): asserts type is string {
  if (typeof type !== 'string' || type.length > 200 || !TYPE_NAME_RE.test(type)) {
    throw new Error(`Invalid $type: ${JSON.stringify(type)}`);
  }
}

export function safeJsonParse(text: string): any {
  return JSON.parse(text, (k, v) => isSafeKey(k) ? v : undefined);
}
