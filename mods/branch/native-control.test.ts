import { createTestDirectory } from './test-directory';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { prepareCredential } from '@treenx/core/kernel/auth/credentials';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { loadLocalMods } from '@treenx/core/mod';
import { createMcpSession } from '#mcp/mcp-session';
import { nativeBranchManifest } from './native';

/** Rooted tool coordinates retain actual Session scope for both control and live publication. */
test('native rooted MCP reads its branch control and refuses live merge outside its credential scope', { timeout: 10_000 }, async () => {
  const directory = await createTestDirectory('native-branch-control-');
  const runtime = await openNativeRuntime({ id: randomUUID(), directory, credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'branch-control-password' }, modules: [nativeBranchManifest()] });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  const delivery = (async () => { for await (const _frame of admin.lane) {} })();
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  let tools: Awaited<ReturnType<typeof createMcpSession>> | undefined;
  let scoped: Awaited<ReturnType<typeof runtime.instance.openSession>> | undefined;
  let treeOnly: Awaited<ReturnType<typeof runtime.instance.openSession>> | undefined;
  try {
    await admin.commit({ opId: key(), changes: [
      { op: 'put', node: { $path: '/live', $type: 't.dir' } },
      { op: 'put', node: { $path: '/live/item', $type: 't.dir', value: 1 } },
      { op: 'put', node: { $path: '/branches', $type: 't.dir' } },
      { op: 'put', node: { $path: '/branches/b', $type: 't.branch', base: '/live', owner: 'admin', status: 'open', title: '', createdAt: 0, mergedAt: 0, conflicts: [],
        '#mount': { $type: 't.mount.branch', pattern: 'tree' } } },
      { op: 'put', node: { $path: '/branches/b/tree', $type: 't.dir' } },
      { op: 'put', node: { $path: '/branches/b/delta', $type: 't.dir' } },
    ] }).outcome;
    const account = (await admin.read({ node: '/admin' })).copies[0];
    if ('error' in account) throw account.error;
    const credential = prepareCredential(account.node.$id, { expiresAt: Date.now() + 60_000, scope: ['/branches/b'] });
    const restricted = prepareCredential(account.node.$id, { expiresAt: Date.now() + 60_000, scope: ['/branches/b/tree'] });
    await admin.commit({ opId: key(), changes: [{ op: 'put', node: credential.node }, { op: 'put', node: restricted.node }] }).outcome;
    scoped = await runtime.instance.openSession(credential.credential);
    tools = await createMcpSession(scoped, '/sys/mcp/catalog', { branchPath: '/branches/b' });
    const copy = (await tools.get_node({ path: '/item' })).copies[0];
    if ('error' in copy) throw copy.error;
    assert.equal(copy.node.$path, '/item');
    assert.equal(copy.node.value, 1);
    const control = (await tools.get_node({ path: '/.branch' })).copies[0];
    if ('error' in control) throw control.error;
    assert.equal(control.node.$path, '/.branch');
    assert.equal(control.node.$type, 't.branch');
    await tools.set_node({ node: { $path: '/item', $type: 't.dir', value: 2 } });
    await tools.execute({ path: '/.branch', action: 'requestMerge', args: {} });
    const reviewed = (await admin.read({ node: '/branches/b' })).copies[0];
    if ('error' in reviewed) throw reviewed.error;
    assert.equal(reviewed.node.status, 'review');
    await assert.rejects(tools.execute({ path: '/.branch', action: 'merge', args: {} }),
      error => error instanceof KernelError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND'));
    const unchanged = (await admin.read({ node: '/live/item' })).copies[0];
    if ('error' in unchanged) throw unchanged.error;
    assert.equal(unchanged.node.value, 1);
    treeOnly = await runtime.instance.openSession(restricted.credential);
    await assert.rejects(createMcpSession(treeOnly, '/sys/mcp/catalog', { branchPath: '/branches/b' }),
      error => error instanceof KernelError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND'));
  } finally {
    treeOnly?.close(); scoped?.close(); admin.close();
    await runtime.close(); await delivery;
    if (tools !== undefined) await tools.done.catch(error => {
      if (!(error instanceof KernelError) || error.code !== 'CANCELLED') throw error;
    });
  }
});

/** Discovery imports the owning native factory without loading legacy branch registrations. */
test('native Branch is collected by the actual kernel module loader', { timeout: 10_000 }, async () => {
  const directory = await createTestDirectory('native-branch-discovery-');
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({
    name: '@treenx/mods', type: 'module', imports: { '#*': './*.ts' },
  }));
  await mkdir(resolve(directory, 'branch'));
  for (const file of ['kernel.ts', 'native.ts', 'native-actions.ts', 'native-types.ts', 'native-index.ts'])
    await copyFile(resolve('branch', file), resolve(directory, 'branch', file));
  await mkdir(resolve(directory, 'branch/schemas'));
  for (const file of ['t.branch.json', 't.branches.json'])
    await copyFile(resolve('branch/schemas', file), resolve(directory, 'branch/schemas', file));
  const collected = await loadLocalMods(directory, 'kernel');
  assert.deepEqual(collected.failed, []);
  assert.equal(collected.manifests.length, 1);
  assert.equal(collected.manifests[0].id, '@treenx/mods/branch');
  assert.ok(collected.manifests[0].types.some(type => type.name === 't.branch'));
});
