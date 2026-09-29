// The t.logs buffer is process-wide, not node data: a node's R must not open it.

import { KernelError } from '#errors';
import { R, W } from '#core';
import { withAcl } from '#security/acl-tree';
import { withExecute } from '#server/actions';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './logs';

describe('t.logs', () => {
  it('a user-made t.logs node does not open the server log buffer', async () => {
    const tree = createMemoryTree();
    await tree.set({ $path: '/', $type: 'root', $acl: [{ g: 'authenticated', p: R | W }, { g: 'admins', p: R | W }] });
    await tree.set({ $path: '/bob-logs', $type: 't.logs' });
    const as = (userId: string, claims: string[]) =>
      withExecute(withAcl(tree, userId, claims), { identity: { userId, claims } });

    await assert.rejects(
      () => as('bob', ['u:bob', 'authenticated']).execute('/bob-logs', 'query', {}),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
    assert.ok(Array.isArray(await as('root', ['u:root', 'admins']).execute('/bob-logs', 'query', {})));
  });
});
