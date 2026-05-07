// Capability: Tree wrapper enforcing readPaths/writePaths intersection over ACL.
// Tests cover path-level enforcement only — action-level checks live in
// executeWithCapability (separate concern, separate test).

import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { withAcl } from '@treenx/core/server/auth';
import { OpError } from '@treenx/core/errors';
import { R, W } from '@treenx/core';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { withCapability, type Capability } from './capability';

let tree: Tree;

beforeEach(async () => {
  tree = createMemoryTree();
  await tree.set({ $path: '/', $type: 'root', $acl: [{ g: 'agent', p: R | W }] });
  await tree.set({ $path: '/allowed', $type: 'dir' });
  await tree.set({ $path: '/allowed/a', $type: 'leaf', value: 1 });
  await tree.set({ $path: '/forbidden', $type: 'dir' });
  await tree.set({ $path: '/forbidden/x', $type: 'leaf', value: 'secret' });
});

const aclTree = () => withAcl(tree, 'workload', ['agent']);

const cap: Capability = {
  readPaths: ['/allowed', '/allowed/*'],
  writePaths: ['/allowed/*'],
  allowedExec: [],
};

describe('withCapability — read', () => {
  it('allows read inside readPaths', async () => {
    const wrapped = withCapability(aclTree(), cap);
    const node = await wrapped.get('/allowed/a');
    assert.equal(node?.value, 1);
  });

  it('denies read outside readPaths', async () => {
    const wrapped = withCapability(aclTree(), cap);
    await assert.rejects(
      wrapped.get('/forbidden/x'),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });
});

describe('withCapability — write', () => {
  it('allows write inside writePaths', async () => {
    const wrapped = withCapability(aclTree(), cap);
    await wrapped.set({ $path: '/allowed/b', $type: 'leaf', value: 2 });
    const node = await tree.get('/allowed/b');
    assert.equal(node?.value, 2);
  });

  it('denies write outside writePaths (read-only on /allowed itself)', async () => {
    const wrapped = withCapability(aclTree(), cap);
    // /allowed is in readPaths but NOT in writePaths
    await assert.rejects(
      wrapped.set({ $path: '/allowed', $type: 'dir', extra: 'mutation' }),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('denies remove outside writePaths', async () => {
    const wrapped = withCapability(aclTree(), cap);
    await assert.rejects(
      wrapped.remove('/forbidden/x'),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('allows remove inside writePaths', async () => {
    const wrapped = withCapability(aclTree(), cap);
    const ok = await wrapped.remove('/allowed/a');
    assert.equal(ok, true);
  });
});

describe('withCapability — empty caps', () => {
  it('empty readPaths denies all reads (fail-closed)', async () => {
    const wrapped = withCapability(aclTree(), { readPaths: [], writePaths: [], allowedExec: [] });
    await assert.rejects(
      wrapped.get('/allowed/a'),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('empty writePaths denies all writes (fail-closed)', async () => {
    const wrapped = withCapability(aclTree(), { readPaths: ['/*', '/**'], writePaths: [], allowedExec: [] });
    await assert.rejects(
      wrapped.set({ $path: '/allowed/c', $type: 'leaf' }),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });
});
