// qvrt: the package surface is a curated exports map — the old `./*` wildcard
// made every internal file public API. Doors must resolve; internals must NOT.
// If a legitimate consumer needs a new door, add an explicit entry — do not
// bring the wildcard back.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
// Unused on purpose: tsc fails if the kernel door stops carrying the normative types.
import type { Session, Store } from '@treenx/core/kernel';

const PUBLIC_DOORS = [
  '.',
  './client',
  './comp',
  './comp/validate',
  './contexts/service',
  './contexts/text',
  './errors',
  './glob',
  './kernel',
  './kernel/store/keys',
  './kernel/testing',
  './log',
  './mod',
  './mods/autostart/service',
  './mount',
  './schema/catalog',
  './schema/load',
  './schema/types',
  './security',
  './security/projector',
  './server/actions',
  './server/client',
  './server/jobs',
  './server/prefab',
  './server/readonly-tree',
  './server/server',
  './testing',
  './tree',
  './tree/branch',
  './tree/cache',
  './tree/migrate-component-namespace',
  './tree/mimefs',
  './tree/patch',
  './tree/trash-exempt',
  './uri',
  './util/debounced-write',
  './util/inflight',
  './util/safe-timers',
  './util/yaml',
  './vite-plugin',
] as const;

describe('exports map (qvrt)', () => {
  it('pins the complete public package surface for migration accounting', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    assert.deepEqual(Object.keys(packageJson.exports).sort(), [...PUBLIC_DOORS].sort());
  });

  it('public doors resolve via package self-reference', async () => {
    for (const door of PUBLIC_DOORS) await import(door === '.' ? '@treenx/core' : `@treenx/core/${door.slice(2)}`);
    const keys = await import('@treenx/core/kernel/store/keys');
    const storeTesting = await import('@treenx/core/kernel/testing');
    assert.equal(typeof keys.toStorageKeys, 'function');
    assert.equal(typeof storeTesting.runStoreContract, 'function');
    const inflight = await import('@treenx/core/util/inflight');
    assert.equal(typeof inflight.createInflight, 'function');
  });

  it('the kernel door exports types, constants and native module authoring', async () => {
    const kernel = await import('@treenx/core/kernel');
    assert.deepEqual(Object.keys(kernel).sort(), ['A', 'DEFAULT_LIMITS', 'R', 'W', 'collectModule', 'registerKernel', 'registerKernelAction']);
  });

  it('internals do not resolve — pipeline wrappers and infra are private', async () => {
    // Non-literal specifiers so tsc doesn't try to resolve them at typecheck.
    const internals: string[] = [
      '@treenx/core/tree/policy',
      '@treenx/core/tree/inflight',
      '@treenx/core/sub',
      '@treenx/core/server/trpc',
      '@treenx/core/security/seed',
      '@treenx/core/core/index.test',
      '@treenx/core/observability/logs',
      '@treenx/core/kernel/types',
    ];
    for (const spec of internals) {
      await assert.rejects(
        import(spec),
        (e: unknown) => (e as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        `${spec} must not be importable`,
      );
    }
  });
});
