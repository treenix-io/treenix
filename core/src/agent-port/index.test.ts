import { registerType } from '#comp';
import { createNode, type GroupPerm, R, register, S, W } from '#core';
import { clearRegistry } from '#testing';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AgentPort, updatePerm } from './index';

function registerAgentPortForTest() {
  registerType('t.agent.port', AgentPort);
  register('t.agent.port', 'schema', () => ({
    $id: 't.agent.port',
    type: 'object' as const,
    properties: {},
    methods: {
      approve: { arguments: [] },
      reset: { arguments: [] },
    },
  }));
}

function delayedSideEffectTree(inner: Tree): Tree {
  return {
    ...inner,
    async set(node, ctx) {
      if (node.$path.startsWith('/auth/users/agent:')) {
        await new Promise(resolve => setImmediate(resolve));
      }
      return inner.set(node, ctx);
    },
    async remove(path, ctx) {
      if (path.startsWith('/auth/users/agent:')) {
        await new Promise(resolve => setImmediate(resolve));
      }
      return inner.remove(path, ctx);
    },
  };
}

describe('updatePerm', () => {
  describe('throws on empty group id', () => {
    it('undefined acl + null perm', () => {
      assert.throws(() => updatePerm(undefined, '', null), /empty group id/);
    });
    it('undefined acl + number perm', () => {
      assert.throws(() => updatePerm(undefined, '', R), /empty group id/);
    });
    it('non-empty acl + null perm', () => {
      assert.throws(() => updatePerm([{ g: 'a', p: R }], '', null), /empty group id/);
    });
    it('non-empty acl + number perm', () => {
      assert.throws(() => updatePerm([{ g: 'a', p: R }], '', R), /empty group id/);
    });
  });

  describe('undefined acl', () => {
    it('null perm → undefined (no-op)', () => {
      assert.equal(updatePerm(undefined, 'g', null), undefined);
    });
    it('number perm → new single-entry array', () => {
      assert.deepEqual(updatePerm(undefined, 'g', R | W), [{ g: 'g', p: R | W }]);
    });
    it('perm = 0 (sticky deny) is valid — creates entry, NOT deletes', () => {
      assert.deepEqual(updatePerm(undefined, 'banned', 0), [{ g: 'banned', p: 0 }]);
    });
  });

  describe('existing group entry', () => {
    it('number perm → in-place update, order preserved, same reference', () => {
      const acl: GroupPerm[] = [{ g: 'a', p: R }, { g: 'b', p: W }, { g: 'c', p: S }];
      const result = updatePerm(acl, 'b', R | W | S);
      assert.deepEqual(result, [{ g: 'a', p: R }, { g: 'b', p: R | W | S }, { g: 'c', p: S }]);
      assert.equal(result, acl);
    });
    it('null perm → splice, order of remaining preserved', () => {
      const acl: GroupPerm[] = [{ g: 'a', p: R }, { g: 'b', p: W }, { g: 'c', p: S }];
      const result = updatePerm(acl, 'b', null);
      assert.deepEqual(result, [{ g: 'a', p: R }, { g: 'c', p: S }]);
      assert.equal(result, acl);
    });
    it('null perm + sole entry → returns undefined (canonical empty)', () => {
      assert.equal(updatePerm([{ g: 'only', p: R }], 'only', null), undefined);
    });
    it('perm = 0 stays as p:0, does NOT delete (distinct from null)', () => {
      const acl: GroupPerm[] = [{ g: 'a', p: R }];
      assert.deepEqual(updatePerm(acl, 'a', 0), [{ g: 'a', p: 0 }]);
    });
  });

  describe('group missing', () => {
    it('number perm → appended', () => {
      const acl: GroupPerm[] = [{ g: 'a', p: R }];
      const result = updatePerm(acl, 'b', W);
      assert.deepEqual(result, [{ g: 'a', p: R }, { g: 'b', p: W }]);
      assert.equal(result, acl);
    });
    it('null perm → no-op, returns same array', () => {
      const acl: GroupPerm[] = [{ g: 'a', p: R }];
      const result = updatePerm(acl, 'b', null);
      assert.equal(result, acl);
      assert.equal(result?.length, 1);
    });
  });

  describe('nullish defensiveness (== null catches undefined too)', () => {
    it('undefined perm treated as delete', () => {
      const acl: GroupPerm[] = [{ g: 'a', p: R }];
      // @ts-expect-error — runtime defense against untyped callers
      assert.equal(updatePerm(acl, 'a', undefined), undefined);
    });
  });

  describe('empty acl array', () => {
    it('null perm → no-op, returns same empty array', () => {
      const acl: GroupPerm[] = [];
      const result = updatePerm(acl, 'g', null);
      assert.equal(result, acl);
      assert.equal(result?.length, 0);
    });
    it('number perm → appends, returns array', () => {
      const acl: GroupPerm[] = [];
      const result = updatePerm(acl, 'g', R);
      assert.deepEqual(result, [{ g: 'g', p: R }]);
      assert.equal(result, acl);
    });
  });
});
