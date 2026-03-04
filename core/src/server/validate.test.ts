import { createNode, type NodeData, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { withValidation } from './validate';

describe('withValidation (Write-Barrier)', () => {
  let store: ReturnType<typeof createMemoryTree>;

  beforeEach(() => {
    clearRegistry();
    store = createMemoryTree();

    register('metadata', 'schema', () => ({
      title: 'Metadata',
      type: 'object',
      properties: {
        title: { type: 'string', title: 'Title' },
        count: { type: 'number', title: 'Count' },
        active: { type: 'boolean', title: 'Active' },
      },
    }));
  });

  it('allows valid components', async () => {
    const vs = withValidation(store);
    await vs.set({
      $path: '/a', $type: 'item',
      metadata: { $type: 'metadata', title: 'Hello', count: 5, active: true },
    } as NodeData);

    const node = await vs.get('/a');
    assert.equal((node?.metadata as any).title, 'Hello');
  });

  it('rejects wrong type: string expected, got number', async () => {
    const vs = withValidation(store);
    await assert.rejects(
      () => vs.set({
        $path: '/a', $type: 'item',
        metadata: { $type: 'metadata', title: 42 },
      } as NodeData),
    );
  });

  it('rejects wrong type: number expected, got string', async () => {
    const vs = withValidation(store);
    await assert.rejects(
      () => vs.set({
        $path: '/a', $type: 'item',
        metadata: { $type: 'metadata', count: 'not a number' },
      } as NodeData),
    );
  });

  it('allows missing optional fields', async () => {
    const vs = withValidation(store);
    // Only title set, count and active missing — fine
    await vs.set({
      $path: '/a', $type: 'item',
      metadata: { $type: 'metadata', title: 'Hello' },
    } as NodeData);
    assert.ok(await vs.get('/a'));
  });

  it('passes through nodes without schemas', async () => {
    const vs = withValidation(store);
    await vs.set({
      $path: '/a', $type: 'item',
      custom: { $type: 'no-schema-type', anything: 'goes' },
    } as NodeData);
    assert.ok(await vs.get('/a'));
  });

  it('skips system fields', async () => {
    const vs = withValidation(store);
    // $path, $type, $rev etc should not trigger validation
    await vs.set(createNode('/a', 'item'));
    assert.ok(await vs.get('/a'));
  });

  it('get/getChildren/remove pass through', async () => {
    const vs = withValidation(store);
    await store.set(createNode('/a', 'item'));
    assert.ok(await vs.get('/a'));
    const children = await vs.getChildren('/');
    assert.equal(children.items.length, 1);
    assert.equal(await vs.remove('/a'), true);
  });
});
