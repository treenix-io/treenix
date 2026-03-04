import { createNode, type NodeData, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { type ActionCtx, serverNodeHandle } from '#server/actions';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { describeTree, exportSchemaForLLM } from '.';

function makeCtx(store: ReturnType<typeof createMemoryTree>, node: NodeData): ActionCtx {
  const nc = serverNodeHandle(store);
  return { node, store, signal: AbortSignal.timeout(5000), nc };
}

describe('exportSchemaForLLM', () => {
  beforeEach(() => clearRegistry());

  it('returns types with schemas', () => {
    register('task', 'schema', () => ({
      title: 'Task',
      type: 'object',
      properties: { status: { type: 'string', title: 'Status' } },
    }));
    register('task', 'react', () => 'component');
    const result = exportSchemaForLLM();
    assert.equal(result.types.length, 1);
    const t = result.types[0];
    assert.equal(t.type, 't.task');
    assert.deepEqual((t.schema as any).title, 'Task');
    assert.ok(t.contexts.includes('schema'));
    assert.ok(t.contexts.includes('react'));
  });

  it('extracts actions from contexts', () => {
    register('task', 'schema', () => ({ title: 'Task', type: 'object', properties: {} }));
    register('task', 'action:complete', () => 'done');
    register('task', 'action:assign', () => 'assigned');
    const result = exportSchemaForLLM();
    const t = result.types[0];
    assert.deepEqual(t.actions.sort(), ['assign', 'complete']);
    assert.ok(!t.contexts.includes('action:complete'));
  });

  it('returns null schema when no schema handler', () => {
    register('widget', 'react', () => 'component');
    const result = exportSchemaForLLM();
    const t = result.types.find((x) => x.type === 't.widget')!;
    assert.equal(t.schema, null);
  });

  it('returns empty types when registry is empty', () => {
    const result = exportSchemaForLLM();
    assert.deepEqual(result.types, []);
  });
});

describe('describeTree', () => {
  beforeEach(() => clearRegistry());

  it('renders tree structure', async () => {
    const store = createMemoryTree();
    const root = createNode('/', 'root');
    await store.set(root);
    await store.set(createNode('/pages', 'dir'));
    await store.set(createNode('/pages/main', 'page'));
    await store.set(createNode('/users', 'dir'));

    const text = await describeTree(makeCtx(store, root), { depth: 3 });
    assert.ok(text.includes('/ (t.root)'));
    assert.ok(text.includes('  pages (t.dir)'));
    assert.ok(text.includes('    main (t.page)'));
    assert.ok(text.includes('  users (t.dir)'));
  });

  it('respects depth limit', async () => {
    const store = createMemoryTree();
    const root = createNode('/', 'root');
    await store.set(root);
    await store.set(createNode('/a', 'dir'));
    await store.set(createNode('/a/b', 'dir'));
    await store.set(createNode('/a/b/c', 'item'));

    const text = await describeTree(makeCtx(store, root), { depth: 1 });
    assert.ok(text.includes('a (t.dir)'));
    assert.ok(!text.includes('b (t.dir)'));
  });

  it('describes subtree from given node', async () => {
    const store = createMemoryTree();
    const pages = createNode('/pages', 'dir');
    await store.set(pages);
    await store.set(createNode('/pages/main', 'page'));

    const text = await describeTree(makeCtx(store, pages), {});
    assert.ok(text.startsWith('/pages (t.dir)'));
    assert.ok(text.includes('main (t.page)'));
  });

  it('sorts children alphabetically', async () => {
    const store = createMemoryTree();
    const root = createNode('/', 'root');
    await store.set(root);
    await store.set(createNode('/zebra', 'animal'));
    await store.set(createNode('/apple', 'fruit'));

    const text = await describeTree(makeCtx(store, root), { depth: 1 });
    const lines = text.split('\n');
    assert.ok(lines.indexOf('  apple (t.fruit)') < lines.indexOf('  zebra (t.animal)'));
  });
});
