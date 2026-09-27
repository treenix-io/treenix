// Agent Port — TOFU connection point for external agents.
// Admin creates this node, agent connects with a secret key,
// admin approves, agent gets scoped access to its subtree.

import { getCtx, registerType } from '#comp';
import { type GroupPerm, R, S, W } from '#core';
import { loadSchemasFromDir } from '#schema/load';

export class AgentPort {
  /** @title Label */
  label: string = '';

  /** @title Status */
  status: 'idle' | 'pending' | 'approved' | 'revoked' = 'idle';

  /** @title Connected */
  connected: boolean = false;

  /** @hidden */
  pendingKey?: string;

  /** @hidden */
  approvedKey?: string;

  /** @title Connected At */
  connectedAt?: number;

  /** Approve pending agent — locks the key, creates user, sets ACL */
  async approve() {
    if (this.status !== 'pending') throw new Error('Can only approve pending agents');
    if (!this.pendingKey) throw new Error('No pending key');

    const { tree, node } = getCtx();
    const agentUserId = `agent:${node.$path}`;
    const groupId = `u:${agentUserId}`;

    this.approvedKey = this.pendingKey;
    this.pendingKey = undefined;
    this.status = 'approved';

    node.$acl = updatePerm(node.$acl, groupId, R | W | S);

    // Side-effect outside the Immer draft — must await so the user node
    // exists before the action resolves.
    await tree.set({
      $path: `/auth/users/${agentUserId}`,
      $type: 'user',
      '#groups': { $type: 'groups', list: ['agent'] },
    });
  }

  /** Revoke agent access — clears key, removes ACL entry, blocks the agent user */
  async revoke() {
    if (this.status !== 'approved') throw new Error('Can only revoke approved agents');

    const { tree, node } = getCtx();
    this.approvedKey = undefined;
    this.status = 'revoked';
    this.connected = false;

    node.$acl = updatePerm(node.$acl, `u:agent:${node.$path}`, null);

    // Live sessions die with the account (resolveToken checks user status);
    // they kept `authenticated` read access for their 7-day TTL otherwise.
    await tree.patch(`/auth/users/agent:${node.$path}`, [['r', 'status', 'blocked']]);
  }

  /** Reset to idle — allows re-pairing with a different agent */
  async reset() {
    if (this.status === 'idle') throw new Error('Already idle');

    const { tree, node } = getCtx();
    const agentUserId = `agent:${node.$path}`;

    this.pendingKey = undefined;
    this.approvedKey = undefined;
    this.status = 'idle';
    this.connected = false;
    this.connectedAt = undefined;

    node.$acl = updatePerm(node.$acl, `u:${agentUserId}`, null);

    await tree.remove(`/auth/users/${agentUserId}`);
  }
}

/** Upsert a group's permission in an ACL list. `perm === null` deletes. */
export function updatePerm(acl: GroupPerm[] | undefined, g: string, perm: number | null): GroupPerm[] | undefined {
  if (!g) throw new Error('updatePerm: empty group id');
  if (!acl) {
    if (perm == null) return undefined;
    else return [{ g, p: perm }];
  } 

  const foundIdx = acl.findIndex(e => e.g === g);
  if (foundIdx >= 0)  {
    if (perm == null) {
      acl.splice(foundIdx, 1);
      return acl.length ? acl : undefined
    } else acl[foundIdx] = { g, p: perm };
  } else if (perm !== null) {
    acl.push({ g, p: perm });
  }

  return acl;
}

registerType('t.agent.port', AgentPort);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
