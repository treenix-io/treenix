import type { NodeData } from '#core';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { OptimisticBuffer } from './optimistic';

// ── Test component: simulates a real registerType class ──

class OrderStatus {
  $type = 'order.status';
  value = 'incoming';

  advance() {
    const transitions: Record<string, string> = {
      incoming: 'kitchen', kitchen: 'ready', ready: 'delivered',
    };
    this.value = transitions[this.value] ?? this.value;
  }

  cancel() {
    this.value = 'cancelled';
  }
}

class Counter {
  $type = 'counter';
  count = 0;
  increment() { this.count++; }
  decrement() { this.count--; }
  add(data: { amount: number }) { this.count += data.amount; }
}

function makeOrder(status = 'incoming'): NodeData {
  return {
    $path: '/orders/1',
    $type: 'order',
    status: { $type: 'order.status', value: status },
  } as NodeData;
}

function makeCounter(count = 0): NodeData {
  return {
    $path: '/counters/1',
    $type: 'counter',
    count,
  } as NodeData;
}

// Helper: create a method caller from class prototype
function methodOf(cls: any, name: string) {
  return (target: any, data: unknown) => cls.prototype[name].call(target, data);
}

let buf: OptimisticBuffer;

describe('OptimisticBuffer', () => {
  beforeEach(() => {
    buf = new OptimisticBuffer();
  });

  // ── Basic apply ──

  describe('apply', () => {
    it('predicts mutation result', () => {
      const node = makeOrder('incoming');
      const { predicted, mutationId } = buf.apply(
        node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined,
      );

      assert.equal((predicted.status as any).value, 'kitchen');
      assert.ok(mutationId.startsWith('opt_'));
    });

    it('does not mutate original node', () => {
      const node = makeOrder('incoming');
      buf.apply(node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);
      assert.equal((node.status as any).value, 'incoming');
    });

    it('passes data to method', () => {
      const node = makeCounter(10);
      const { predicted } = buf.apply(
        node, 'counter', 'add', methodOf(Counter, 'add'), { amount: 5 },
      );
      assert.equal((predicted as any).count, 15);
    });

    it('throws when component not found', () => {
      const node = makeOrder();
      assert.throws(
        () => buf.apply(node, 'nonexistent', 'foo', () => {}, undefined),
      );
    });

    it('works when component type matches node $type (root-level)', () => {
      const node = makeCounter(0);
      const { predicted } = buf.apply(
        node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined,
      );
      assert.equal((predicted as any).count, 1);
    });
  });

  // ── Confirm (happy path) ──

  describe('confirm', () => {
    it('confirms matching prediction — no rollback', () => {
      const node = makeOrder('incoming');
      buf.apply(node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);

      const serverNode = makeOrder('kitchen');
      const { node: result, rolledBack } = buf.confirm('/orders/1', serverNode);

      assert.equal(rolledBack, false);
      assert.equal((result.status as any).value, 'kitchen');
      assert.equal(buf.hasPending('/orders/1'), false);
    });

    it('returns server node directly when no pending mutations', () => {
      const serverNode = makeOrder('ready');
      const { node, rolledBack } = buf.confirm('/orders/1', serverNode);
      assert.equal(rolledBack, false);
      assert.equal((node.status as any).value, 'ready');
    });
  });

  // ── Conflict (server disagrees) ──

  describe('conflict resolution', () => {
    it('rolls back when server returns different result', () => {
      const node = makeOrder('incoming');
      buf.apply(node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);

      // Server says "cancelled" instead of "kitchen" — someone else cancelled first
      const serverNode = makeOrder('cancelled');
      const { node: result, rolledBack } = buf.confirm('/orders/1', serverNode);

      assert.equal(rolledBack, true);
      assert.equal((result.status as any).value, 'cancelled');
      assert.equal(buf.hasPending('/orders/1'), false);
    });

    it('server wins even with multiple pending mutations', () => {
      const node = makeOrder('incoming');
      buf.apply(node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);
      // Second optimistic mutation on top of first prediction
      const { predicted } = buf.apply(
        { ...makeOrder('kitchen'), $path: '/orders/1' } as NodeData,
        'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined,
      );
      assert.equal((predicted.status as any).value, 'ready');
      assert.equal(buf.getPendingCount('/orders/1'), 2);

      // Server says cancelled — both pending are wrong
      const { node: result, rolledBack } = buf.confirm('/orders/1', makeOrder('cancelled'));
      assert.equal(rolledBack, true);
      assert.equal((result.status as any).value, 'cancelled');
      assert.equal(buf.getPendingCount('/orders/1'), 0);
    });
  });

  // ── Multiple pending mutations ──

  describe('multiple pending mutations', () => {
    it('stacks mutations on same path', () => {
      const node = makeCounter(0);
      buf.apply(node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      const node2 = makeCounter(1);
      node2.$path = '/counters/1';
      buf.apply(node2, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      assert.equal(buf.getPendingCount('/counters/1'), 2);

      const optimistic = buf.getOptimistic('/counters/1');
      assert.equal((optimistic as any).count, 2);
    });

    it('confirms first mutation, keeps rest pending', () => {
      const node = makeCounter(0);
      buf.apply(node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      const node2 = makeCounter(1);
      node2.$path = '/counters/1';
      buf.apply(node2, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      // Server confirms count=1 (first increment)
      const serverNode = makeCounter(1);
      serverNode.$path = '/counters/1';
      const { node: result } = buf.confirm('/counters/1', serverNode);

      // Should still show optimistic count=2 from remaining mutation
      // (rebase applies second increment on top of confirmed base)
      assert.equal(buf.getPendingCount('/counters/1'), 1);
    });

    it('independent paths do not interfere', () => {
      const order = makeOrder('incoming');
      buf.apply(order, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);

      const counter = makeCounter(0);
      buf.apply(counter, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      assert.equal(buf.getPendingCount('/orders/1'), 1);
      assert.equal(buf.getPendingCount('/counters/1'), 1);
      assert.equal(buf.getPendingCount(), 2);

      // Confirm order, counter still pending
      buf.confirm('/orders/1', makeOrder('kitchen'));
      assert.equal(buf.hasPending('/orders/1'), false);
      assert.equal(buf.hasPending('/counters/1'), true);
    });
  });

  // ── Rollback ──

  describe('rollback', () => {
    it('rollback returns baseline state', () => {
      const node = makeOrder('incoming');
      buf.apply(node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);

      const baseline = buf.rollback('/orders/1');
      assert.equal((baseline!.status as any).value, 'incoming');
      assert.equal(buf.hasPending('/orders/1'), false);
    });

    it('rollback returns undefined when no pending', () => {
      assert.equal(buf.rollback('/nothing'), undefined);
    });

    it('rollbackById removes specific mutation', () => {
      const node = makeCounter(0);
      const { mutationId: id1 } = buf.apply(
        node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined,
      );
      const node2 = makeCounter(1);
      node2.$path = '/counters/1';
      const { mutationId: id2 } = buf.apply(
        node2, 'counter', 'increment', methodOf(Counter, 'increment'), undefined,
      );

      assert.equal(buf.getPendingCount('/counters/1'), 2);

      const baseline = buf.rollbackById(id1);
      assert.ok(baseline);
      assert.equal(buf.getPendingCount('/counters/1'), 1);

      // Remaining mutation is the second one
      assert.equal(buf.confirmById(id2), true);
      assert.equal(buf.getPendingCount('/counters/1'), 0);
    });

    it('rollbackById returns undefined for unknown id', () => {
      assert.equal(buf.rollbackById('nonexistent'), undefined);
    });
  });

  // ── Expiration ──

  describe('expire', () => {
    it('expires mutations older than maxAge', () => {
      const node = makeCounter(0);
      buf.apply(node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      // Hack: backdate the mutation
      const mutations = (buf as any).pending.get('/counters/1');
      mutations[0].createdAt = Date.now() - 10_000;

      const expired = buf.expire(5_000);
      assert.equal(expired.length, 1);
      assert.equal(buf.hasPending('/counters/1'), false);
    });

    it('keeps recent mutations', () => {
      const node = makeCounter(0);
      buf.apply(node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      const expired = buf.expire(60_000);
      assert.equal(expired.length, 0);
      assert.equal(buf.hasPending('/counters/1'), true);
    });

    it('expires only the old ones in a mixed set', () => {
      const node = makeCounter(0);
      buf.apply(node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      const node2 = makeCounter(1);
      node2.$path = '/counters/1';
      buf.apply(node2, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      // Backdate only the first
      const mutations = (buf as any).pending.get('/counters/1');
      mutations[0].createdAt = Date.now() - 10_000;

      const expired = buf.expire(5_000);
      assert.equal(expired.length, 1);
      assert.equal(buf.getPendingCount('/counters/1'), 1);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('getOptimistic returns undefined when no pending', () => {
      assert.equal(buf.getOptimistic('/nonexistent'), undefined);
    });

    it('clear removes everything', () => {
      buf.apply(makeOrder(), 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);
      buf.apply(makeCounter(), 'counter', 'increment', methodOf(Counter, 'increment'), undefined);
      assert.equal(buf.getPendingCount(), 2);
      buf.clear();
      assert.equal(buf.getPendingCount(), 0);
    });

    it('confirm with $rev difference still matches (rev ignored)', () => {
      const node = makeOrder('incoming');
      buf.apply(node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);

      const serverNode = makeOrder('kitchen');
      serverNode.$rev = 42; // Server bumps rev, prediction doesn't have it
      const { rolledBack } = buf.confirm('/orders/1', serverNode);

      assert.equal(rolledBack, false);
    });

    it('handles rapid fire mutations', () => {
      let node = makeCounter(0);
      for (let i = 0; i < 100; i++) {
        const { predicted } = buf.apply(
          node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined,
        );
        node = predicted;
      }

      assert.equal(buf.getPendingCount('/counters/1'), 100);
      const optimistic = buf.getOptimistic('/counters/1');
      assert.equal((optimistic as any).count, 100);
    });

    it('mutation IDs are unique', () => {
      const ids = new Set<string>();
      const node = makeCounter(0);
      for (let i = 0; i < 50; i++) {
        const { mutationId } = buf.apply(
          node, 'counter', 'increment', methodOf(Counter, 'increment'), undefined,
        );
        ids.add(mutationId);
      }
      assert.equal(ids.size, 50);
    });

    it('handles node where component is the root (node.$type matches)', () => {
      // When the node itself IS the component (no nested component field)
      const node: NodeData = { $path: '/x', $type: 'counter', count: 5 } as any;
      const { predicted } = buf.apply(
        node, 'counter', 'add', methodOf(Counter, 'add'), { amount: 3 },
      );
      assert.equal((predicted as any).count, 8);
    });

    it('deep-nested objects in component are properly cloned', () => {
      const node: NodeData = {
        $path: '/deep',
        $type: 'container',
        meta: {
          $type: 'order.status',
          value: 'incoming',
          nested: { deep: { array: [1, 2, 3] } },
        },
      } as any;

      const { predicted } = buf.apply(
        node, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined,
      );

      // Original untouched
      assert.equal((node.meta as any).value, 'incoming');
      // Predicted mutated
      assert.equal((predicted.meta as any).value, 'kitchen');
      // Deep nested preserved
      assert.deepEqual((predicted.meta as any).nested.deep.array, [1, 2, 3]);
    });
  });

  // ── Concurrency patterns ──

  describe('concurrency', () => {
    it('two users edit different paths — no interference', () => {
      const order = makeOrder('incoming');
      const counter = makeCounter(0);

      buf.apply(order, 'order.status', 'advance', methodOf(OrderStatus, 'advance'), undefined);
      buf.apply(counter, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      // Order confirmed correctly
      const { rolledBack: r1 } = buf.confirm('/orders/1', makeOrder('kitchen'));
      assert.equal(r1, false);

      // Counter still pending
      assert.equal(buf.hasPending('/counters/1'), true);

      // Counter confirmed
      const c = makeCounter(1);
      c.$path = '/counters/1';
      const { rolledBack: r2 } = buf.confirm('/counters/1', c);
      assert.equal(r2, false);
    });

    it('interleaved apply-confirm on same path', () => {
      // Apply mutation 1
      buf.apply(makeCounter(0), 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      // Before confirm, apply mutation 2
      const c1 = makeCounter(1);
      c1.$path = '/counters/1';
      buf.apply(c1, 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      assert.equal(buf.getPendingCount('/counters/1'), 2);

      // Server confirms mutation 1 (count=1)
      const s1 = makeCounter(1);
      s1.$path = '/counters/1';
      const { rolledBack } = buf.confirm('/counters/1', s1);
      assert.equal(rolledBack, false);

      // One mutation still pending
      assert.equal(buf.getPendingCount('/counters/1'), 1);
    });

    it('late server response after all mutations expired', () => {
      buf.apply(makeCounter(0), 'counter', 'increment', methodOf(Counter, 'increment'), undefined);

      // Expire everything
      const mutations = (buf as any).pending.get('/counters/1');
      mutations[0].createdAt = 0;
      buf.expire(1);

      // Server responds late — no pending to reconcile
      const s = makeCounter(1);
      s.$path = '/counters/1';
      const { node, rolledBack } = buf.confirm('/counters/1', s);
      assert.equal(rolledBack, false);
      assert.equal((node as any).count, 1);
    });
  });
});
