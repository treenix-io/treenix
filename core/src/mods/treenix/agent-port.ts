// Agent Port — TOFU connection point for external agents.
// Admin creates this node, agent connects with a secret key,
// admin approves, agent gets scoped access to its subtree.

import { getCtx, registerType } from '#comp';
import { R, S, W } from '#core';

class AgentPort {
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
  approve() {
    if (this.status !== 'pending') throw new Error('Can only approve pending agents');
    if (!this.pendingKey) throw new Error('No pending key');

    const { tree, node } = getCtx();
    const path = node.$path;
    const agentUserId = `agent:${path}`;

    this.approvedKey = this.pendingKey;
    this.pendingKey = undefined;
    this.status = 'approved';

    // ACL: grant agent R+W+S on its subtree (inherits to children)
    const agentPerm = { g: `u:${agentUserId}`, p: R | W | S };
    const acl = (node.$acl ?? []).filter((e: { g: string }) => e.g !== agentPerm.g);
    acl.push(agentPerm);
    (this as any).$acl = acl;

    // Create user node with 'agent' group (fire-and-forget, tree is outside Immer)
    tree.set({
      $path: `/auth/users/${agentUserId}`,
      $type: 'user',
      groups: { $type: 'groups', list: ['agent'] },
    });
  }

  /** Revoke agent access — clears key, removes ACL entry */
  revoke() {
    if (this.status !== 'approved') throw new Error('Can only revoke approved agents');

    const { node } = getCtx();
    const agentUserId = `agent:${node.$path}`;

    this.approvedKey = undefined;
    this.status = 'revoked';
    this.connected = false;

    // Remove agent from ACL
    const acl = (node.$acl ?? []).filter((e: { g: string }) => e.g !== `u:${agentUserId}`);
    (this as any).$acl = acl;
  }

  /** Reset to idle — allows re-pairing with a different agent */
  reset() {
    if (this.status === 'idle') throw new Error('Already idle');

    const { tree, node } = getCtx();
    const agentUserId = `agent:${node.$path}`;

    this.pendingKey = undefined;
    this.approvedKey = undefined;
    this.status = 'idle';
    this.connected = false;
    this.connectedAt = undefined;

    // Remove agent from ACL
    const acl = (node.$acl ?? []).filter((e: { g: string }) => e.g !== `u:${agentUserId}`);
    (this as any).$acl = acl;

    // Remove agent user (fire-and-forget)
    tree.remove(`/auth/users/${agentUserId}`);
  }
}

registerType('t.agent.port', AgentPort);
