import { registerType } from '#comp';
import { createNode, isComponent, normalizeType, resolve } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { collectSiblings, createNodeHandle, executeAction, registerBuiltinActions } from './actions';

// ── Component classes ──

class Metadata {
  title = '';
  description = '';

  async rename({ title }: { title: string }) {
    this.title = title;
  }

  async clear() {
    this.title = '';
    this.description = '';
  }
}

class Status {
  value = 'draft';

  async publish() {
    this.value = 'published';
  }

  async draft() {
    this.value = 'draft';
  }
}

// ── Tests ──

describe('defineComponent', () => {
  beforeEach(() => {
    clearRegistry();
  });

  function setup() {
    registerType('metadata', Metadata);
    registerType('status', Status);
  }

  it('registers methods as action:name', () => {
    setup();
    assert.ok(resolve('metadata', 'action:rename'));
    assert.ok(resolve('metadata', 'action:clear'));
    assert.ok(resolve('status', 'action:publish'));
  });

  it('stores class → type mapping', () => {
    setup();
    assert.equal(normalizeType(Metadata), 't.metadata');
    assert.equal(normalizeType(Status), 't.status');
  });

  it('action mutates component via this', () => {
    setup();
    const comp = { $type: 'metadata', title: 'old', description: 'desc' } as any;
    resolve('metadata', 'action:rename')!({ comp } as any, { title: 'new' });
    assert.equal(comp.title, 'new');
    assert.equal(comp.description, 'desc');
  });

  it('end-to-end: simulate trpc execute', async () => {
    setup();
    const store = createMemoryTree();
    await store.set(
      createNode('/p', 'page', {}, {
        metadata: { $type: 'metadata', title: 'old', description: 'x' },
        status: { $type: 'status', value: 'draft' },
      }),
    );

    async function execute(path: string, component: string, action: string, data?: unknown) {
      const n = (await store.get(path))!;
      const cv = n[component];
      if (!isComponent(cv)) throw new Error(`Component "${component}" not found`);
      const siblings = collectSiblings(n, component);
      resolve(cv.$type, `action:${action}`)!({ node: n, comp: cv, siblings, store } as any, data);
      await store.set(n);
    }

    await execute('/p', 'metadata', 'rename', { title: 'new' });
    await execute('/p', 'status', 'publish');

    const result = (await store.get('/p'))!;
    assert.equal((result['metadata'] as any).title, 'new');
    assert.equal((result['status'] as any).value, 'published');
  });

  it('node.get(Class).action() — typed client proxy', async () => {
    setup();
    const calls: any[] = [];
    const mockStream = (_input: any) => (async function* () {})();
    const node = createNodeHandle(async (input: any) => {
      calls.push(input);
    }, mockStream);

    const page = node('/pages/main');
    await page.get(Metadata).rename({ title: 'test' });
    await page.get(Status).publish();

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      path: '/pages/main',
      type: 't.metadata',
      key: undefined,
      action: 'rename',
      data: { title: 'test' },
    });
    assert.deepEqual(calls[1], {
      path: '/pages/main',
      type: 't.status',
      key: undefined,
      action: 'publish',
      data: undefined,
    });
  });

  it('defineComponent with needs option', () => {
    registerType('metadata', Metadata, { needs: ['status'] });
    registerType('status', Status);

    const node = createNode('/p', 'page', {}, {
      metadata: { $type: 'metadata', title: 'old', description: 'x' },
      status: { $type: 'status', value: 'draft' },
    });
    const siblings = collectSiblings(node, 'metadata');
    assert.equal(Object.keys(siblings).length, 1);
    assert.equal((siblings.status as any).value, 'draft');
  });

  it('action receives deps as second arg', () => {
    class Article {
      title = '';

      publishAndRename({ title }: { title: string }, deps: { status: any }) {
        this.title = title;
        deps.status.value = 'published';
      }
    }

    registerType('article', Article, { needs: ['status'] });
    registerType('status', Status);

    const node = createNode('/a', 'page', {}, {
      article: { $type: 'article', title: 'old' },
      status: { $type: 'status', value: 'draft' },
    });

    const comp = node['article'] as any;
    const deps = collectSiblings(node, 'article');
    resolve(comp.$type, 'action:publishAndRename')!({ node, comp, deps } as any, {
      title: 'new',
    });

    assert.equal(comp.title, 'new');
    assert.equal((node['status'] as any).value, 'published');
  });

  it('patch action: shallow fields', async () => {
    registerBuiltinActions();
    const store = createMemoryTree();
    await store.set(createNode('/n', 'mytype', { title: 'old', count: 1 }));

    await executeAction(store, '/n', undefined, undefined, 'patch', { title: 'new', count: 2 });

    const result = (await store.get('/n'))!;
    assert.equal(result.title, 'new');
    assert.equal(result.count, 2);
  });

  it('patch action: deep merges nested objects', async () => {
    registerBuiltinActions();
    const store = createMemoryTree();
    await store.set(createNode('/n', 'mytype', {
      mesh: { $type: 't3d.mesh', width: 5, height: 10 },
    }));

    await executeAction(store, '/n', undefined, undefined, 'patch', {
      mesh: { width: 20 },
    });

    const result = (await store.get('/n'))!;
    const mesh = result.mesh as any;
    assert.equal(mesh.width, 20);
    assert.equal(mesh.height, 10);
    assert.equal(mesh.$type, 't3d.mesh');
  });

  it('patch action: guards $ fields', async () => {
    registerBuiltinActions();
    const store = createMemoryTree();
    await store.set(createNode('/n', 'mytype', { title: 'ok' }));

    await executeAction(store, '/n', undefined, undefined, 'patch', {
      $type: 'hacked', $path: '/evil', title: 'patched',
    });

    const result = (await store.get('/n'))!;
    assert.equal(result.$type, 't.mytype');
    assert.equal(result.$path, '/n');
    assert.equal(result.title, 'patched');
  });

  it('patch action: replaces arrays wholesale', async () => {
    registerBuiltinActions();
    const store = createMemoryTree();
    await store.set(createNode('/n', 'mytype', { tags: ['a', 'b'] }));

    await executeAction(store, '/n', undefined, undefined, 'patch', { tags: ['c'] });

    const result = (await store.get('/n'))!;
    assert.deepEqual(result.tags, ['c']);
  });

  it('end-to-end execute with needs injection', async () => {
    class Article {
      title = '';

      publishAndRename({ title }: { title: string }, deps: { status: any }) {
        this.title = title;
        deps.status.value = 'published';
      }
    }

    registerType('article', Article, { needs: ['status'] });
    registerType('status', Status);

    const store = createMemoryTree();
    await store.set(
      createNode('/a', 'page', {}, {
        article: { $type: 'article', title: 'old' },
        status: { $type: 'status', value: 'draft' },
      }),
    );

    const node = (await store.get('/a'))!;
    const comp = node['article'] as any;
    const deps = collectSiblings(node, 'article');
    resolve(comp.$type, 'action:publishAndRename')!({ node, comp, deps, store } as any, {
      title: 'new',
    });
    await store.set(node);

    const result = (await store.get('/a'))!;
    assert.equal((result['article'] as any).title, 'new');
    assert.equal((result['status'] as any).value, 'published');
  });

  it('executeAction resolves dotless node.$type against normalized componentType', async () => {
    // Regression: normalizeType('autostart') → 't.autostart', but node.$type is 'autostart'.
    // resolveActionHandler compared raw node.$type against normalized componentType — mismatch.
    class Svc {
      async ping() { return 'pong'; }
    }
    registerType('svc', Svc);

    const store = createMemoryTree();
    await store.set({ $path: '/s', $type: 'svc' } as NodeData);

    // componentType = 't.svc' (normalized), node.$type = 'svc' (raw) — must match
    const result = await executeAction(store, '/s', 't.svc', undefined, 'ping', undefined);
    assert.equal(result, 'pong');
  });
});
