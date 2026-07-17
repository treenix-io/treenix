// qvrt: the package surface is a curated exports map — the old `./*` wildcard
// made every internal file public API. Doors must resolve; internals must NOT.
// If a legitimate consumer needs a new door, add an explicit entry — do not
// bring the wildcard back.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const PUBLIC_DOORS = [
  '.',
  './client',
  './comp',
  './comp/validate',
  './contexts/service',
  './errors',
  './glob',
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
  './tree/inflight',
  './tree/migrate-component-namespace',
  './tree/mimefs',
  './tree/patch',
  './tree/trash-exempt',
  './uri',
  './util/debounced-write',
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
    await import('@treenx/core');
    await import('@treenx/core/comp');
    await import('@treenx/core/tree');
    await import('@treenx/core/errors');
    await import('@treenx/core/testing');
    await import('@treenx/core/server/actions');
    await import('@treenx/core/security');
  });

  it('internals do not resolve — pipeline wrappers and infra are private', async () => {
    // Non-literal specifiers so tsc doesn't try to resolve them at typecheck.
    const internals: string[] = [
      '@treenx/core/tree/policy',
      '@treenx/core/sub',
      '@treenx/core/server/trpc',
      '@treenx/core/security/seed',
      '@treenx/core/core/index.test',
      '@treenx/core/observability/logs',
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
