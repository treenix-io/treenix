import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { KernelError } from '#errors';
import { prepareCredential } from '#kernel/auth/credentials';
import { R, W, type Operation } from '#kernel/types';
import { openNativeDeployment } from '#server/native-deployment';
import { approvalKey } from '@treenx/mods/agent/native-guardian';
import { createMcpSession } from '@treenx/mods/mcp/mcp-session';

/** The discovered Guardian must retain its predicate and approval service in the same deployment. */
test(
  'native Guardian deployment refuses, requests approval and retries with both gate owners',
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(resolve('temp/native-guardian-deployment-'));
    let explicitCalls = 0;
    const runtime = await openNativeDeployment({
      runtime: {
        id: randomUUID(),
        directory,
        credentialTtlMs: 60_000,
        firstAdmin: { path: '/admin', name: 'admin', password: 'guardian-password' },
        gates: [
          async () => {
            explicitCalls++;
            return 'pass';
          },
        ],
      },
      modules: [
        {
          id: 'guardian-deployment',
          entry: new URL('../../../mods/agent/kernel.ts', import.meta.url).href,
        },
        {
          id: '@treenx/core/autostart',
          entry: new URL('../mods/autostart/kernel.ts', import.meta.url).href,
        },
      ],
    });
    try {
      const admin = await createMcpSession(
        await runtime.instance.openSession(runtime.instance.setupCredential),
      );
      await admin.set_node({
        node: {
          $path: '/guardian',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      });
      await admin.set_node({
        node: {
          $path: '/guardian/service',
          $type: 'ai.guardian',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      });
      const owner = (await admin.get_node({ path: '/guardian/service' })).copies[0];
      if ('error' in owner) throw owner.error;
      const self = `n:${owner.node.$id}`;
      await admin.set_node({
        expect: { nodes: [{ path: owner.node.$path, rev: owner.node.$rev }] },
        node: {
          $path: '/guardian/approvals',
          $type: 't.dir',
          $acl: [{ subject: { group: self }, grant: R | W }],
        },
      });
      await admin.set_node({
        node: {
          $path: '/auth/users/agent',
          $type: 't.user',
          name: 'agent',
          status: 'active',
          '#groups': { $type: 't.groups', list: ['agent'] },
        },
      });
      const account = (await admin.get_node({ path: '/auth/users/agent' })).copies[0];
      if ('error' in account) throw account.error;
      await admin.set_node({
        node: {
          $path: '/work',
          $type: 't.dir',
          $acl: [{ subject: { group: `u:${account.node.$id}` }, grant: R | W }],
        },
      });
      await admin.set_node({ node: { $path: '/starter', $type: 't.autostart' } });
      const starter = (await admin.get_node({ path: '/starter' })).copies[0];
      if ('error' in starter) throw starter.error;
      await admin.commit({
        expect: {
          nodes: [
            { path: starter.node.$path, rev: starter.node.$rev },
            { path: owner.node.$path, rev: owner.node.$rev },
          ],
        },
        changes: [
          {
            op: 'patch',
            path: '/starter',
            ops: { $set: { $acl: [{ subject: { group: `n:${starter.node.$id}` }, grant: R }] } },
          },
          {
            op: 'patch',
            path: '/guardian/service',
            ops: {
              $set: {
                $acl: [
                  { subject: { group: 'public' }, grant: R },
                  { subject: { group: self }, grant: R },
                  { subject: { group: `n:${starter.node.$id}` }, grant: R },
                ],
              },
            },
          },
          {
            op: 'put',
            node: {
              $path: '/starter/guardian',
              $type: 't.ref',
              $ref: '/guardian/service',
              $refId: owner.node.$id,
            },
          },
        ],
      });
      await admin.commit({ changes: [{ op: 'move', from: '/starter', to: '/sys/autostart' }] });
      const issued = prepareCredential(account.node.$id, {
        expiresAt: Date.now() + 60_000,
        scope: ['/work', '/guardian'],
      });
      await admin.set_node({ node: issued.node });
      const session = await runtime.instance.openSession(issued.credential),
        agent = await createMcpSession(session);
      await assert.rejects(
        agent.get_node({ path: '/admin' }),
        (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
      );
      const operation: Extract<Operation, { kind: 'commit' }> = {
        kind: 'commit',
        changes: [{ op: 'put', node: { $path: '/work/accepted', $type: 't.dir' } }],
      };
      await assert.rejects(
        agent.commit({ changes: operation.changes }),
        (error) => error instanceof KernelError && error.code === 'REFUSED',
      );
      await agent.execute({
        path: '/guardian/service',
        action: 'request_approval',
        args: { operation },
      });
      await admin.execute({
        path: `/guardian/approvals/${approvalKey(session.actor.principal, operation)}`,
        action: 'approve',
        args: {},
      });
      await agent.commit({ changes: operation.changes });
      assert.equal((await agent.get_node({ path: '/work/accepted' })).copies.length, 1);
      assert.ok(explicitCalls > 0);
    } finally {
      await runtime.close();
    }
  },
);
