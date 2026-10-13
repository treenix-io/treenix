// qvrt: the package surface is a curated exports map — the old `./*` wildcard
// made every internal file public API. Doors must resolve; internals must NOT.
// If a legitimate consumer needs a new door, add an explicit entry — do not
// bring the wildcard back.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
// Unused on purpose: tsc fails if the kernel door stops carrying the normative types.
import type { Session, Store } from '@treenx/core/kernel';
import { createInstance } from '#kernel/instance';

const PUBLIC_DOORS = [
  '.',
  './client',
  './client/handle',
  './client/http-twp',
  './client/lane-cache',
  './client/twp',
  './comp',
  './comp/client-declaration',
  './comp/handle',
  './comp/validate',
  './contexts/text',
  './errors',
  './glob',
  './kernel',
  './kernel/action-publication',
  './kernel/auth/credentials',
  './kernel/blob-archives',
  './kernel/blob-references',
  './kernel/blob-store-memory',
  './kernel/chain-index',
  './kernel/expr',
  './kernel/input-boundary',
  './kernel/journal',
  './kernel/manifest',
  './kernel/migrate',
  './kernel/module-declaration',
  './kernel/order',
  './kernel/periodic-service',
  './kernel/position',
  './kernel/read-children',
  './kernel/runtime',
  './kernel/serialization',
  './kernel/session-delivery',
  './kernel/source-action',
  './kernel/store/commit',
  './kernel/store/journal-index',
  './kernel/store/keys',
  './kernel/store/memory',
  './kernel/store/rawfs-codec',
  './kernel/store/scan',
  './kernel/testing',
  './kernel/transfer-image',
  './kernel/type-description',
  './kernel/typedef',
  './kernel/types',
  './kernel/uix-publication',
  './kernel/update-ops',
  './kernel/watched-service',
  './log',
  './mod',
  './mod/native-prefab',
  './mod/prefab-path',
  './protocol/serve-port',
  './protocol/twp',
  './protocol/twp-loopback',
  './protocol/twp-port',
  './schema/load',
  './schema/types',
  './security',
  './server/http-routes',
  './server/http-twp',
  './server/native-deployment',
  './system/native-actions',
  './tools/upgrade-kernel',
  './tools/upgrade-kernel-plan',
  './uri',
  './util/chunk-channel',
  './util/debounced-write',
  './util/inflight',
  './util/is-record',
  './util/safe-timers',
  './util/stable-json',
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

  it('the kernel door exports the canonical factory and native module authoring', async () => {
    const kernel = await import('@treenx/core/kernel');
    assert.deepEqual(Object.keys(kernel).sort(), [
      'A', 'DEFAULT_LIMITS', 'R', 'W', 'createInstance',
      'getActionContext', 'getActionLifetime', 'instantiateModule',
    ]);
    assert.equal(kernel.createInstance, createInstance);
    assert.equal(typeof kernel.getActionLifetime, 'function');
  });

  it('internals do not resolve — pipeline wrappers and infra are private', async () => {
    // Non-literal specifiers so tsc doesn't try to resolve them at typecheck.
    const internals: string[] = [
      '@treenx/core/tree',
      '@treenx/core/tree/branch',
      '@treenx/core/tree/mimefs',
      '@treenx/core/tree/patch',
      '@treenx/core/server/prefab',
      '@treenx/core/testing',
      '@treenx/core/core/registry',
      '@treenx/core/lab/legacy-core',
      '@treenx/core/tree/policy',
      '@treenx/core/tree/inflight',
      '@treenx/core/sub',
      '@treenx/core/server/trpc',
      '@treenx/core/server/client',
      '@treenx/core/server/actions',
      '@treenx/core/server/jobs',
      '@treenx/core/server/readonly-tree',
      '@treenx/core/contexts/service',
      '@treenx/core/server/server',
      '@treenx/core/mods/autostart/service',
      '@treenx/core/security/seed',
      '@treenx/core/core/index.test',
      '@treenx/core/observability/logs',
      '@treenx/core/kernel/instance',
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
