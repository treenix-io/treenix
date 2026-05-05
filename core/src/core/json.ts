// Prototype-pollution defense for object keys + JSON parsing.

export function isSafeKey(name: string): boolean {
  return name !== '__proto__' && name !== 'constructor' && name !== 'prototype';
}

export function assertSafeKey(name: string) {
  if (!isSafeKey(name)) throw new Error(`Forbidden prototype key: ${name}`);
}

export function safeJsonParse(text: string): any {
  return JSON.parse(text, (k, v) => isSafeKey(k) ? v : undefined);
}
