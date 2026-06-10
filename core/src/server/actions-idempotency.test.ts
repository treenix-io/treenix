import { registerType } from '#comp';
import { createNode, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createTreeP } from '#protocol/treep';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { executeAction } from './actions';

let attempts = 0;

class Pay {
  paid = 0;

  async charge({ amount }: { amount: number }) {
    attempts++;
    this.paid = this.paid + amount;
    return this.paid;
  }

  async fail() {
    attempts++;
    throw new Error('payment gateway down');
  }
}

const paySchema = () => ({
  $id: 'pay', title: 'Pay', type: 'object' as const,
  properties: { paid: { type: 'number' } },
  methods: {
    charge: { arguments: [{ name: 'data', type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] }] },
    fail: { arguments: [] },
  },
});

describe('executeAction idempotency (opId)', () => {
  beforeEach(() => {
    clearRegistry();
    registerType('pay', Pay);
    register('pay', 'schema', paySchema);
    attempts = 0;
  });

  it('replay with the same opId applies once and returns the first result', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'pay', { paid: 0 }));
    const opId = 'op-charge-1';

    const first = await executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 100 }, { opId });
    const replay = await executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 100 }, { opId });

    assert.equal(attempts, 1);
    assert.equal(first, 100);
    assert.equal(replay, 100);
    assert.equal((await tree.get('/p'))!.paid, 100);
  });

  it('concurrent duplicates share one execution', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'pay', { paid: 0 }));
    const opId = 'op-charge-concurrent';

    const [a, b] = await Promise.all([
      executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 50 }, { opId }),
      executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 50 }, { opId }),
    ]);

    assert.equal(attempts, 1);
    assert.equal(a, 50);
    assert.equal(b, 50);
    assert.equal((await tree.get('/p'))!.paid, 50);
  });

  it('different opIds execute independently', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'pay', { paid: 0 }));

    await executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 10 }, { opId: 'op-a' });
    await executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 10 }, { opId: 'op-b' });

    assert.equal(attempts, 2);
    assert.equal((await tree.get('/p'))!.paid, 20);
  });

  it('without opId every call applies', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'pay', { paid: 0 }));

    await executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 10 });
    await executeAction(tree, '/p', undefined, undefined, 'charge', { amount: 10 });

    assert.equal(attempts, 2);
    assert.equal((await tree.get('/p'))!.paid, 20);
  });

  it('a failed execution is cached: the retry sees the same error, not a second attempt', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'pay', { paid: 0 }));
    const opId = 'op-fail-1';

    await assert.rejects(
      executeAction(tree, '/p', undefined, undefined, 'fail', undefined, { opId }),
      /payment gateway down/,
    );
    await assert.rejects(
      executeAction(tree, '/p', undefined, undefined, 'fail', undefined, { opId }),
      /payment gateway down/,
    );

    assert.equal(attempts, 1);
  });

  it('treep forwards opId from set() to the action executor', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'pay', { paid: 0 }));

    const seen: Array<string | undefined> = [];
    const tp = createTreeP(tree, async (_path, _key, _action, _data, opId) => {
      seen.push(opId);
      return null;
    });

    await tp.set('/p#charge()', { amount: 1 }, { opId: 'op-via-treep' });
    await tp.set('/p#charge()', { amount: 1 });

    assert.deepEqual(seen, ['op-via-treep', undefined]);
  });
});
