// Agent seed shape — guardian gate defaults + '#' component keys (core-1prz).
// Bare {$type}-valued keys are snapshots after the namespace cutover: a seed
// deploying `policy:` instead of `'#policy'` ships an agent whose policy
// getComponent can never see — the gate silently runs on fallback only.

import { getComponent } from '@treenx/core';
import { getPrefab } from '@treenx/core/mod';
import { deployByKey } from '@treenx/core/server/prefab';
import { createMemoryTree } from '@treenx/core/tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './seed';
import { AiChat, AiPolicy } from './types';

const nodes = () => getPrefab('agent', 'seed')!.nodes;
const byPath = (p: string) => {
  const n = nodes().find(n => n.$path === p);
  assert.ok(n, `seed node ${p} exists`);
  return n!;
};

describe('agent seed (core-1prz)', () => {
  it('guardian: reads allowed, mutations escalate, no blanket treenix allow', () => {
    const g = byPath('guardian');
    const allow = g.allow as string[];
    const escalate = g.escalate as string[];

    assert.ok(!allow.includes('mcp__treenix__*'), 'no blanket mcp__treenix__* (the polluted-root bug)');
    assert.ok(!allow.includes('*'));
    assert.ok(escalate.includes('mcp__treenix__set_node'));
    assert.ok(escalate.includes('mcp__treenix__execute:*'));
    assert.ok(escalate.includes('mcp__treenix__deploy_prefab'));
  });

  it('guardian subtree is deny for agent tool calls and admin-only by ACL', () => {
    const g = byPath('guardian');
    const deny = g.deny as string[];
    assert.ok(deny.includes('mcp__treenix__set_node:/guardian*'));
    assert.ok(deny.includes('mcp__treenix__execute:*:/guardian*'));

    const acl = g.$acl as Array<{ g: string; p: number }>;
    assert.equal(acl.find(e => e.g === 'admins')?.p, 15);
    assert.equal(acl.find(e => e.g === 'agents')?.p, 1, 'agents read policy, never write it');

    const approvals = byPath('guardian/approvals');
    const aAcl = approvals.$acl as Array<{ g: string; p: number }>;
    assert.equal(aAcl.find(e => e.g === 'agents')?.p, 0, 'agents sticky-denied on approvals');
  });

  it('agent components are deployed under # keys, never bare', () => {
    for (const path of ['agents/qa', 'agents/mcp']) {
      const n = byPath(path);
      assert.ok(n['#policy'], `${path} has #policy`);
      assert.ok(!('policy' in n), `${path} has no bare policy snapshot`);
    }
    const qa = byPath('agents/qa');
    assert.ok(qa['#chat'] && qa['#thread']);
    assert.ok(!('chat' in qa) && !('thread' in qa));
  });

  it('deployed qa agent resolves policy and chat via getComponent', async () => {
    const tree = createMemoryTree();
    await deployByKey(tree, 'agent', 'seed', '/', { allowAbsolute: true });

    const qa = await tree.get('/agents/qa');
    assert.ok(qa);
    const policy = getComponent(qa!, AiPolicy);
    assert.ok(policy, 'AiPolicy visible to getComponent (regression: bare key was invisible)');
    assert.ok(policy!.allow.some(p => p.startsWith('Bash:npm test')));
    assert.ok(getComponent(qa!, AiChat), 'AiChat visible for session resume');
  });
});
