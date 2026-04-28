// API Token server actions — create/revoke long-lived tokens for MCP agents
// Extends shared type from types.ts with server-only implementations.

import { createNode } from '@treenx/core';
import { getCtx, registerType } from '@treenx/core/comp';
import { createSession, revokeSession } from '@treenx/core/server/auth';
import { ApiTokenManager } from './types';

class ApiTokenServer extends ApiTokenManager {

  /** @mutation Create API token for an agent */
  create(data: { name: string }) {
    if (!data?.name) throw new Error('name required');
    if (!/^[a-z0-9-]+$/.test(data.name)) throw new Error('name must be lowercase alphanumeric with dashes');

    const { tree, node } = getCtx();
    const userId = `api:${data.name}`;
    const path = node.$path;

    (async () => {
      const userPath = `/auth/users/${userId}`;
      if (!await tree.get(userPath)) {
        await tree.set(createNode(userPath, 'user', { status: 'active' }, {
          groups: { $type: 'groups', list: ['admins'] },
        }));
      }

      const token = await createSession(tree, userId, {
        ttlMs: 10 * 365 * 24 * 60 * 60 * 1000,
      });

      await tree.set({
        $path: `${path}/${data.name}`,
        $type: 't.api.token',
        name: data.name,
        userId,
        token,
        createdAt: Date.now(),
      });
    })();
  }

  /** @mutation Revoke an API token by name */
  revoke(data: { name: string }) {
    if (!data?.name) throw new Error('name required');

    const { tree, node } = getCtx();
    const tokenPath = `${node.$path}/${data.name}`;

    (async () => {
      const tokenNode = await tree.get(tokenPath);
      if (!tokenNode) throw new Error(`Token "${data.name}" not found`);

      const tok = tokenNode['token'];
      if (typeof tok === 'string') await revokeSession(tree, tok);
      await tree.remove(tokenPath);
    })();
  }
}

registerType('t.api.tokens', ApiTokenServer, { override: true });
