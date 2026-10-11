import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { schemaOrgV29NativeManifest } from '@treenx/jsonld-types';
import { R, W } from '@treenx/core/kernel';
import { KernelError } from '@treenx/core/errors';
import type { ModuleManifest, ServiceHandler } from '@treenx/core/kernel/types';
import { nativeAuditManifest, readAuditHistory } from '#audit/native-history';
import { resolveNativeContext } from '#metatron/native-service';
import { createMcpSession } from '#mcp/mcp-session';
import { nativeCanaryManifest } from '#canary/native-service';

/** Verify native journal reads, eager JSON-LD writes and mention reads by an actual node service. */
test('native audit JSON-LD and context ports use accepted owners', async () => {
  const temporary = new URL('../../../temp/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('native-ports-data-', temporary)));
  let resolved = (_value: { principal: string; context: string }) => {};
  const context = new Promise<{ principal: string; context: string }>(resolve => { resolved = resolve; });
  const service: ServiceHandler = async (_node, session) => {
    const done = (async () => {
      try { for await (const frame of session.lane) if (frame.t === 'fail') throw frame.error; }
      catch (error) { if (!(error instanceof KernelError) || (error.code !== 'CANCELLED' && error.code !== 'UNAUTHENTICATED')) throw error; }
    })();
    resolved({ principal: session.actor.principal, context: await resolveNativeContext(session, ['Read @/allowed and @/private']) });
    return { done, async stop() { await done; } };
  };
  const module: ModuleManifest = { id: 'native-port-test', open: [], security: [{ type: 'metatron.reader-test', context: 'service', handler: service }],
    types: [{ name: 'metatron.reader-test', module: 'native-port-test', security: 'user-capability', version: 1, schema: { type: 'object', additionalProperties: false }, actions: {} }] };
  let canaryResolve = () => {};
  const canaryPassed = new Promise<void>(resolve => { canaryResolve = resolve; });
  const runtime = await openNativeRuntime({ id: 'native-ports', directory, credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'smoke-password' }, modules: [nativeAuditManifest(), schemaOrgV29NativeManifest(), module, nativeCanaryManifest(canaryResolve)] });
  try {
    const session = await runtime.instance.openSession(runtime.instance.setupCredential);
    const admin = await createMcpSession(session);
    await admin.set_node({ node: { $path: '/records/one', $type: 't.dir', value: 1 } });
    await admin.commit({ changes: [{ op: 'patch', path: '/records/one', ops: { $set: { value: 2 } } }, { op: 'put', node: { $path: '/records/two', $type: 't.dir' } }] });
    const rows = await readAuditHistory(session, '/records');
    assert.deepEqual(rows.map(row => row.path), ['/records/one', '/records/one', '/records/two']);
    await admin.set_node({ node: { $path: '/audit-reader', $type: 'audit.reader', target: '/records' } });
    const history = await admin.execute({ path: '/audit-reader', action: 'history', args: {} });
    assert.deepEqual(history.value, rows);
    await admin.set_node({ node: { $path: '/person', $type: 'jsonld.schema-org.Person', name: 'Alice', knows: [{ $type: 'jsonld.schema-org.Person', name: 'Bob' }], address: { $type: 't.ref', $ref: '/address' } } });
    assert.equal((await admin.get_node({ path: '/person' })).copies.length, 1);
    await assert.rejects(admin.set_node({ node: { $path: '/invalid-person', $type: 'jsonld.schema-org.Person', name: 42 } }), error => error instanceof KernelError && error.code === 'INVALID');
    await admin.set_node({ node: { $path: '/context-owner', $type: 'metatron.reader-test' } });
    const owner = (await admin.get_node({ path: '/context-owner' })).copies[0];
    if ('error' in owner) throw owner.error;
    const self = `n:${owner.node.$id}`;
    await admin.set_node({ expect: { nodes: [{ path: owner.node.$path, rev: owner.node.$rev }] }, node: { $path: '/allowed', $type: 't.dir', note: 'visible context', password: 'private-password', $acl: [{ subject: { group: self }, grant: R }] } });
    await admin.set_node({ node: { $path: '/private', $type: 't.dir', note: 'private-marker' } });
    await admin.commit({ expect: { nodes: [{ path: owner.node.$path, rev: owner.node.$rev }] }, changes: [{ op: 'patch', path: owner.node.$path, ops: { $set: { $acl: [{ subject: { group: self }, grant: R }] } } }] });
    await admin.commit({ changes: [{ op: 'move', from: owner.node.$path, to: '/sys/autostart' }] });
    const output = await context;
    assert.equal(output.principal, self);
    assert.equal(output.context.includes('visible context'), true);
    assert.equal(output.context.includes('private-password'), false);
    assert.equal(output.context.includes('private-marker'), false);
    assert.equal(output.context.includes('(not found or access denied)'), true);
    await admin.remove_node({ path: '/sys/autostart' });
    await admin.set_node({ node: { $path: '/canary-owner', $type: 'canary.runner' } });
    const canary = (await admin.get_node({ path: '/canary-owner' })).copies[0];
    if ('error' in canary) throw canary.error;
    await admin.commit({ expect: { nodes: [{ path: canary.node.$path, rev: canary.node.$rev }] }, changes: [{ op: 'patch', path: canary.node.$path, ops: { $set: { $acl: [{ subject: { group: `n:${canary.node.$id}` }, grant: R | W }] } } }] });
    await admin.commit({ changes: [{ op: 'move', from: '/canary-owner', to: '/sys/autostart' }] });
    await canaryPassed;
    const canaryJournal = await readAuditHistory(session, '/sys/autostart/test-item');
    assert.equal(canaryJournal.length, 4);
    assert.equal(canaryJournal[3].after, null);
  } finally { await runtime.close(); }
});
