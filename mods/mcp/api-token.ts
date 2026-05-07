// API Token server actions — create/revoke long-lived tokens for MCP agents
// Extends shared type from types.ts with server-only implementations.

import { createNode } from '@treenx/core';
import { getCtx, registerActions } from '@treenx/core/comp';
import { createSession, sessionPath } from '@treenx/core/server/auth';
import { API_TOKEN_GROUPS, ApiTokenGroup, ApiTokenManager } from './types';

/** Server-side registry for creating and revoking machine credentials. */
class ApiTokenServer extends ApiTokenManager {

  /** @mutation Create API token for an agent. Returns the raw token ONCE — server stores only the hash. */
  async create(data: { name: string; groups?: ApiTokenGroup[] }) {
    if (!data?.name) throw new Error('name required');
    if (!/^[a-z0-9-]+$/.test(data.name)) throw new Error('name must be lowercase alphanumeric with dashes');

    // R5-MCP-2: validate explicit groups against allowlist; default is least-privilege (no groups).
    // Previous behaviour silently granted 'admins' on every token.
    const groups: string[] = (data.groups ?? []).filter(g => API_TOKEN_GROUPS.includes(g));

    const { tree, node } = getCtx();
    const userId = `api:${data.name}`;
    const path = node.$path;

    const userPath = `/auth/users/${userId}`;
    if (!await tree.get(userPath)) {
      await tree.set(createNode(userPath, 'user', { status: 'active' }, {
        groups: { $type: 'groups', list: groups },
      }));
    }

    const token = await createSession(tree, userId, {
      ttlMs: 10 * 365 * 24 * 60 * 60 * 1000,
    });

    // R5-MCP-1: persist only the resolved session-node path (which is keyed by sha256(token)
    // per R4-AUTH-5). The raw token is returned to the caller exactly once and never stored.
    await tree.set({
      $path: `${path}/${data.name}`,
      $type: 't.api.token',
      name: data.name,
      userId,
      groups,
      sessionRef: sessionPath(token),
      createdAt: Date.now(),
    });

    return { token, userId };
  }

  /** @mutation Revoke an API token by name */
  async revoke(data: { name: string }) {
    if (!data?.name) throw new Error('name required');

    const { tree, node } = getCtx();
    const tokenPath = `${node.$path}/${data.name}`;

    const tokenNode = await tree.get(tokenPath);
    if (!tokenNode) throw new Error(`Token "${data.name}" not found`);

    // R5-MCP-1: revoke via stored session-node path (we no longer hold the plaintext token).
    const sessionRef = tokenNode['sessionRef'];
    if (typeof sessionRef === 'string') await tree.remove(sessionRef);
    await tree.remove(tokenPath);
  }
}

registerActions('t.api.tokens', ApiTokenServer, { override: true, noOptimistic: ['create', 'revoke'] });
