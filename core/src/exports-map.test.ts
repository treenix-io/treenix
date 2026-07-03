// qvrt: the package surface is a curated exports map — the old `./*` wildcard
// made every internal file public API. Doors must resolve; internals must NOT.
// If a legitimate consumer needs a new door, add an explicit entry — do not
// bring the wildcard back.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('exports map (qvrt)', () => {
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
      '@treenx/core/tree/volatile',
      '@treenx/core/tree/validation',
      '@treenx/core/tree/trash',
      '@treenx/core/tree/migration',
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
