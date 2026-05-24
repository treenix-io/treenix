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

    node.$acl = setGroupPerm(node.$acl, groupId, R | W | S);

    // Side-effect outside the Immer draft — must await so the user node
    // exists before the action resolves.
    await tree.set({
      $path: `/auth/users/${agentUserId}`,
      $type: 'user',
      groups: { $type: 'groups', list: ['agent'] },
    });
  }

  /** Revoke agent access — clears key, removes ACL entry */
  revoke() {
    if (this.status !== 'approved') throw new Error('Can only revoke approved agents');

    const { node } = getCtx();
    this.approvedKey = undefined;
    this.status = 'revoked';
    this.connected = false;

    node.$acl = setGroupPerm(node.$acl, `u:agent:${node.$path}`, null);
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

    node.$acl = setGroupPerm(node.$acl, `u:${agentUserId}`, null);

    await tree.remove(`/auth/users/${agentUserId}`);
  }
}

/** Upsert a group's permission in an ACL list. `perm === null` deletes. */
function setGroupPerm(acl: GroupPerm[] | undefined, g: string, perm: number | null): GroupPerm[] {
  const filtered = (acl ?? []).filter(e => e.g !== g);
  return perm === null ? filtered : [...filtered, { g, p: perm }];
}

registerType('t.agent.port', AgentPort);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
