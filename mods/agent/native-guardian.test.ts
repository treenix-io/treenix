import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { prepareCredential } from '@treenx/core/kernel/auth/credentials';
import { KernelError } from '@treenx/core/errors';
import { R, W, A } from '@treenx/core/kernel';
import type { Operation } from '@treenx/core/kernel/types';
import { createNativeGuardian, approvalKey } from '#agent/native-guardian';
import { createMcpSession } from '#mcp/mcp-session';
import { nativeApiTokenManifest } from '#mcp/native-api-token';
import { z } from 'zod/v3';

/** Refuse a scoped native mutation until an explicit request and administrator approval are delivered. */
test('native guardian refuses then permits an approved scoped operation', async () => {
  const temporary = new URL('../../../temp/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('native-guardian-data-', temporary)));
  const guardian = createNativeGuardian('/guardian/approvals', '/sys/autostart');
  const runtime = await openNativeRuntime({ id: 'native-guardian', directory, credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'smoke-password' }, modules: [guardian.manifest, nativeApiTokenManifest()], gates: [guardian.gate] });
  try {
    const admin = await createMcpSession(await runtime.instance.openSession(runtime.instance.setupCredential));
    await admin.set_node({ node: { $path: '/guardian-service', $type: 'ai.guardian', $acl: [{ subject: { group: 'public' }, grant: R }] } });
    const owner = (await admin.get_node({ path: '/guardian-service' })).copies[0];
    if ('error' in owner) throw owner.error;
    const self = `n:${owner.node.$id}`;
    await admin.set_node({ node: { $path: '/auth/users/mcp-agent', $type: 't.user', name: 'mcp-agent', status: 'active', '#groups': { $type: 't.groups', list: ['agent'] } } });
    const account = (await admin.get_node({ path: '/auth/users/mcp-agent' })).copies[0];
    if ('error' in account) throw account.error;
    const user = `u:${account.node.$id}`;
    await admin.set_node({ expect: { nodes: [{ path: owner.node.$path, rev: owner.node.$rev }] }, node: { $path: '/guardian/approvals', $type: 't.dir', $acl: [{ subject: { group: self }, grant: R | W }] } });
    await admin.set_node({ node: { $path: '/mcp-scoped', $type: 't.dir', $acl: [{ subject: { group: user }, grant: R | W }] } });
    await admin.commit({ expect: { nodes: [{ path: owner.node.$path, rev: owner.node.$rev }] }, changes: [
      { op: 'patch', path: '/guardian-service', ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R }, { subject: { group: self }, grant: R | W | A }] } } },
    ] });
    await admin.commit({ changes: [{ op: 'move', from: '/guardian-service', to: '/sys/autostart' }] });
    const issued = prepareCredential(account.node.$id, { expiresAt: Date.now() + 60_000, scope: ['/mcp-scoped', '/sys/autostart'] });
    await admin.set_node({ node: issued.node });
    const session = await runtime.instance.openSession(issued.credential);
    const agent = await createMcpSession(session);
    await assert.rejects(agent.get_node({ path: '/admin' }), error => error instanceof KernelError && error.code === 'NOT_FOUND');
    const operation: Extract<Operation, { kind: 'commit' }> = { kind: 'commit', changes: [{ op: 'put', node: { $path: '/mcp-scoped/approved', $type: 't.dir' } }] };
    await assert.rejects(agent.commit({ changes: operation.changes }), error => error instanceof KernelError && error.code === 'REFUSED');
    await agent.execute({ path: '/sys/autostart', action: 'request_approval', args: { operation } });
    const approved = new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(5000);
      signal.addEventListener('abort', () => { remove(); reject(signal.reason); }, { once: true });
      const remove = guardian.subscribe(() => { void guardian.verdict(operation, session.actor).then(verdict => { if (verdict === 'pass') { remove(); resolve(); } }, reject); });
    });
    await admin.execute({ path: `/guardian/approvals/${approvalKey(session.actor.principal, operation)}`, action: 'approve', args: {} });
    await approved;
    await agent.commit({ changes: operation.changes });
    assert.equal((await agent.get_node({ path: '/mcp-scoped/approved' })).copies.length, 1);
    await admin.set_node({ node: { $path: '/api-tokens', $type: 't.api.tokens' } });
    const minted = await admin.execute({ path: '/api-tokens', action: 'create', args: { name: 'MCP token', groups: [], scope: ['/mcp-scoped'] } });
    const token = z.object({ id: z.string().uuid(), token: z.string(), userId: z.string() }).parse(minted.value);
    assert.equal(token.userId.startsWith('u:'), true);
    const tokenSession = await runtime.instance.openSession({ token: token.token });
    const tokenTools = await createMcpSession(tokenSession);
    await assert.rejects(tokenTools.get_node({ path: '/admin' }), error => error instanceof KernelError && error.code === 'NOT_FOUND');
    await admin.execute({ path: '/api-tokens', action: 'revoke', args: { id: token.id } });
    await assert.rejects(tokenTools.get_node({ path: '/mcp-scoped' }), error => error instanceof KernelError);
  } finally { await runtime.close(); }
});
