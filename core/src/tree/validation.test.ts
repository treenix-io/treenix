import { createNode, type NodeData, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { withValidation } from './validation';

describe('withValidation (Write-Barrier)', () => {
  let tree: ReturnType<typeof createMemoryTree>;

  beforeEach(() => {
    clearRegistry();
    tree = createMemoryTree();

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
    const vs = withValidation(tree);
    await vs.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5, active: true },
    } as NodeData);

    const node = await vs.get('/a');
    assert.equal((node?.['#metadata'] as any).title, 'Hello');
  });

  it('rejects wrong type: string expected, got number', async () => {
    const vs = withValidation(tree);
    await assert.rejects(
      () => vs.set({
        $path: '/a', $type: 'item',
        '#metadata': { $type: 'metadata', title: 42 },
      } as NodeData),
    );
  });

  it('rejects wrong type: number expected, got string', async () => {
    const vs = withValidation(tree);
    await assert.rejects(
      () => vs.set({
        $path: '/a', $type: 'item',
        '#metadata': { $type: 'metadata', count: 'not a number' },
      } as NodeData),
    );
  });

  it('allows missing optional fields', async () => {
    const vs = withValidation(tree);
    // Only title set, count and active missing — fine
    await vs.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello' },
    } as NodeData);
    assert.ok(await vs.get('/a'));
  });

  it('passes through nodes without schemas', async () => {
    const vs = withValidation(tree);
    await vs.set({
      $path: '/a', $type: 'item',
      '#custom': { $type: 'no-schema-type', anything: 'goes' },
    } as NodeData);
    assert.ok(await vs.get('/a'));
  });

  it('skips system fields', async () => {
    const vs = withValidation(tree);
    // $path, $type, $rev etc should not trigger validation
    await vs.set(createNode('/a', 'item'));
    assert.ok(await vs.get('/a'));
  });

  it('rejects patch that produces invalid state', async () => {
    const vs = withValidation(tree);
    // Write a valid node
    await vs.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5 },
    } as NodeData);
    // Patch count to a string — violates schema (number expected)
    await assert.rejects(
      () => vs.patch('/a', [['r', '#metadata.count', 'not-a-number']]),
      (e: Error) => e.name === 'OpError' && e.message.includes('Validation'),
    );
  });

  it('allows valid patch', async () => {
    const vs = withValidation(tree);
    await vs.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5 },
    } as NodeData);
    // Patch count to a valid number
    await vs.patch('/a', [['r', '#metadata.count', 10]]);
    const node = await vs.get('/a');
    assert.equal((node?.['#metadata'] as any).count, 10);
  });

  it('patch never writes invalid data to underlying tree', async () => {
    const vs = withValidation(tree);
    await vs.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5 },
    } as NodeData);

    // Spy on inner tree to detect any writes
    let innerSetCalls = 0;
    const origSet = tree.set.bind(tree);
    tree.set = async (node, ctx) => { innerSetCalls++; return origSet(node, ctx); };
    innerSetCalls = 0;

    // Invalid patch — should throw without writing to inner tree
    await assert.rejects(
      () => vs.patch('/a', [['r', '#metadata.count', 'not-a-number']]),
    );
    assert.equal(innerSetCalls, 0, 'no writes should reach inner tree on validation failure');

    // Verify the original data is intact
    const node = await tree.get('/a');
    assert.equal((node?.['#metadata'] as any).count, 5);
  });

  it('get/getChildren/remove pass through', async () => {
    const vs = withValidation(tree);
    await tree.set(createNode('/a', 'item'));
    assert.ok(await vs.get('/a'));
    const children = await vs.getChildren('/');
    assert.equal(children.items.length, 1);
    assert.equal(await vs.remove('/a'), true);
  });
});
