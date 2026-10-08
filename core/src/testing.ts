// Test-support helpers: registry reset + snapshot for test isolation.
// Public entry `@treenx/core/testing` — consumed by other packages' tests
// (harness, backup) which previously deep-imported core/index.test.ts.
// Importing this module registers the shared test.* schema types — side
// effect preserved from the original core/index.test.ts home (qvrt).

import { mapRegistry, register, resolve, unregister } from '#core';
import { registerBuiltins } from '#core/builtins';
import { ambientModule, clearAmbientRegistrations, publishModules } from '#kernel/manifest';
import type { Registry } from '#kernel/types';

const testTypes = ['test.doc', 'test.item', 'test.session', 'test.task'];

export function registerTestTypes() {
  for (const t of testTypes)
    register(t, 'schema', () => ({ $id: t, type: 'object' as const, title: t, properties: {} }));
}

registerTestTypes();

export function clearRegistry(): void {
  clearAmbientRegistrations();
  mapRegistry((t, c) => unregister(t, c));
  registerBuiltins();
  registerTestTypes();
}

export function publishAmbientModule(registry: Registry): void {
  publishModules(registry, [ambientModule()]);
}

/** Save current registry state — pairs with restoreRegistrySnapshot */
export function saveRegistrySnapshot(): Map<string, unknown> {
  const snap = new Map<string, unknown>();
  mapRegistry((t, c) => { snap.set(`${t}@${c}`, resolve(t, c, false)); });
  return snap;
}

/** Restore a saved snapshot — clears registry then re-registers all entries */
export function restoreRegistrySnapshot(snap: Map<string, unknown>): void {
  mapRegistry((t, c) => unregister(t, c));
  for (const [key, handler] of snap) {
    const i = key.lastIndexOf('@');
    register(key.slice(0, i), key.slice(i + 1), handler as any);
  }
}
