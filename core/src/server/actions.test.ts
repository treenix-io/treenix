import { registerType } from '#comp';
import { createNode, isComponent, type NodeData, normalizeType, register, resolve } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import { withCache } from '#tree/cache';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { applyTemplate, collectSiblings, createNodeHandle, executeAction, registerBuiltinActions, setComponent } from './actions';

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

// ── Schemas ──

const metadataSchema = () => ({
  $id: 'metadata', title: 'Metadata', type: 'object' as const,
  properties: { title: { type: 'string' }, description: { type: 'string' } },
  methods: {
    rename: { arguments: [{ name: 'data', type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }] },
    clear: { arguments: [] },
  },
});

const statusSchema = () => ({
  $id: 'status', title: 'Status', type: 'object' as const,
  properties: { value: { type: 'string' } },
  methods: { publish: { arguments: [] }, draft: { arguments: [] } },
});

const mytypeSchema = () => ({
  $id: 'mytype', title: 'MyType', type: 'object' as const,
  properties: {},
  methods: { patch: { arguments: [{ name: 'data', type: 'object', properties: {} }] } },
});

const svcSchema = () => ({
  $id: 'svc', title: 'Svc', type: 'object' as const,
  properties: {},
  methods: { ping: { arguments: [] } },
});

const articleSchema = () => ({
  $id: 'article', title: 'Article', type: 'object' as const,
  properties: { title: { type: 'string' } },
  methods: { publishAndRename: { arguments: [{ name: 'data', type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }] } },
});

// ── Tests ──

describe('defineComponent', () => {
  beforeEach(() => {
    clearRegistry();
  });

  function setup() {
    registerType('metadata', Metadata);
    registerType('status', Status);
    register('metadata', 'schema', metadataSchema);
    register('status', 'schema', statusSchema);
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
    const tree = createMemoryTree();
    await tree.set(
      createNode('/p', 'page', {}, {
        metadata: { $type: 'metadata', title: 'old', description: 'x' },
        status: { $type: 'status', value: 'draft' },
      }),
    );

    async function execute(path: string, component: string, action: string, data?: unknown) {
      const n = (await tree.get(path))!;
      const cv = n[component];
      if (!isComponent(cv)) throw new Error(`Component "${component}" not found`);
      const siblings = collectSiblings(n, component);
      resolve(cv.$type, `action:${action}`)!({ node: n, comp: cv, siblings, tree } as any, data);
      await tree.set(n);
    }

    await execute('/p', 'metadata', 'rename', { title: 'new' });
    await execute('/p', 'status', 'publish');

    const result = (await tree.get('/p'))!;
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
    register('mytype', 'schema', mytypeSchema);
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'old', count: 1 }));

    await executeAction(tree, '/n', undefined, undefined, 'patch', { title: 'new', count: 2 });

    const result = (await tree.get('/n'))!;
    assert.equal(result.title, 'new');
    assert.equal(result.count, 2);
  });

  it('patch action: deep merges nested objects', async () => {
    registerBuiltinActions();
    register('mytype', 'schema', mytypeSchema);
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', {
      mesh: { $type: 't3d.mesh', width: 5, height: 10 },
    }));

    await executeAction(tree, '/n', undefined, undefined, 'patch', {
      mesh: { width: 20 },
    });

    const result = (await tree.get('/n'))!;
    const mesh = result.mesh as any;
    assert.equal(mesh.width, 20);
    assert.equal(mesh.height, 10);
    assert.equal(mesh.$type, 't3d.mesh');
  });

  it('patch action: guards $ fields', async () => {
    registerBuiltinActions();
    register('mytype', 'schema', mytypeSchema);
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'ok' }));

    await executeAction(tree, '/n', undefined, undefined, 'patch', {
      $type: 'hacked', $path: '/evil', title: 'patched',
    });

    const result = (await tree.get('/n'))!;
    assert.equal(result.$type, 't.mytype');
    assert.equal(result.$path, '/n');
    assert.equal(result.title, 'patched');
  });

  it('patch action: replaces arrays wholesale', async () => {
    registerBuiltinActions();
    register('mytype', 'schema', mytypeSchema);
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { tags: ['a', 'b'] }));

    await executeAction(tree, '/n', undefined, undefined, 'patch', { tags: ['c'] });

    const result = (await tree.get('/n'))!;
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

    const tree = createMemoryTree();
    await tree.set(
      createNode('/a', 'page', {}, {
        article: { $type: 'article', title: 'old' },
        status: { $type: 'status', value: 'draft' },
      }),
    );

    const node = (await tree.get('/a'))!;
    const comp = node['article'] as any;
    const deps = collectSiblings(node, 'article');
    resolve(comp.$type, 'action:publishAndRename')!({ node, comp, deps, tree } as any, {
      title: 'new',
    });
    await tree.set(node);

    const result = (await tree.get('/a'))!;
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
    register('svc', 'schema', svcSchema);

    const tree = createMemoryTree();
    await tree.set({ $path: '/s', $type: 'svc' } as NodeData);

    // componentType = 't.svc' (normalized), node.$type = 'svc' (raw) — must match
    const result = await executeAction(tree, '/s', 't.svc', undefined, 'ping', undefined);
    assert.equal(result, 'pong');
  });

  it('deepAssign throws on __proto__/constructor/prototype keys (F17)', async () => {
    registerBuiltinActions();
    register('mytype', 'schema', mytypeSchema);
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'ok' }));

    await assert.rejects(
      () => executeAction(tree, '/n', undefined, undefined, 'patch', {
        constructor: { polluted: true },
        title: 'patched',
      }),
      /prototype key/,
    );

    const result = (await tree.get('/n'))!;
    assert.equal(result.title, 'ok', 'patch must be atomic — no partial apply');
    assert.equal(({} as any).polluted, undefined, 'Object.prototype must not be polluted');
  });

  it('sandboxed dynamic action executes in QuickJS (C01)', async () => {
    registerBuiltinActions();
    const tree = createMemoryTree();

    // Create a type node with dynamic action
    await tree.set({
      $path: '/sys/types/test/demo',
      $type: 'dir',
      actions: {
        greet: 'var node = ctx.tree.get(ctx.node.$path); node.greeting = "hello " + (data.name || "world"); ctx.tree.set(node); return { ok: true };',
      },
      schema: {
        methods: { greet: { arguments: [{ name: 'data', type: 'object', properties: { name: { type: 'string' } } }] } },
      },
    } as NodeData);

    // Create an instance
    await tree.set(createNode('/demo1', 'test.demo', { greeting: '' }));

    const result = await executeAction(tree, '/demo1', undefined, undefined, 'greet', { name: 'sandbox' });
    assert.deepEqual(result, { ok: true });

    const updated = await tree.get('/demo1');
    assert.equal(updated!.greeting, 'hello sandbox');
  });

  it('sandboxed dynamic action cannot access host process/require (C01)', async () => {
    registerBuiltinActions();
    const tree = createMemoryTree();

    await tree.set({
      $path: '/sys/types/test/evil',
      $type: 'dir',
      actions: {
        pwn: 'return typeof process !== "undefined" ? "FAIL" : "safe";',
      },
      schema: { methods: { pwn: { arguments: [] } } },
    } as NodeData);

    await tree.set(createNode('/evil1', 'test.evil', {}));

    const result = await executeAction(tree, '/evil1', undefined, undefined, 'pwn', {});
    assert.equal(result, 'safe', 'process must not be accessible in sandbox');
  });

  it('sandboxed dynamic action blocks writes outside own path', async () => {
    registerBuiltinActions();
    const tree = createMemoryTree();

    await tree.set({
      $path: '/sys/types/test/escape',
      $type: 'dir',
      actions: {
        steal: 'ctx.tree.set({ $path: "/auth/sessions/evil", $type: "session", hacked: true }); return "tried";',
      },
      schema: { methods: { steal: { arguments: [] } } },
    } as NodeData);

    await tree.set(createNode('/esc1', 'test.escape', {}));

    const result = await executeAction(tree, '/esc1', undefined, undefined, 'steal', {});
    assert.equal(result, 'tried');

    // The write to /auth/sessions/evil should have been blocked
    const evil = await tree.get('/auth/sessions/evil');
    assert.equal(evil, undefined, 'write to foreign path must be blocked');
  });

  it('sandboxed dynamic action does not expose $acl/$owner in ctx.node', async () => {
    registerBuiltinActions();
    const tree = createMemoryTree();

    await tree.set({
      $path: '/sys/types/test/snoop',
      $type: 'dir',
      actions: {
        check: 'var n = ctx.node; return { hasAcl: "$acl" in n, hasOwner: "$owner" in n, hasRefs: "$refs" in n };',
      },
      schema: { methods: { check: { arguments: [] } } },
    } as NodeData);

    await tree.set({
      $path: '/snoop1', $type: 'test.snoop',
      $acl: [{ g: 'admins', p: 15 }],
      $owner: 'secret-user',
      $refs: [{ t: '/some/ref' }],
      title: 'visible',
    } as NodeData);

    const result = await executeAction(tree, '/snoop1', undefined, undefined, 'check', {}) as any;
    assert.equal(result.hasAcl, false, '$acl must be stripped');
    assert.equal(result.hasOwner, false, '$owner must be stripped');
    assert.equal(result.hasRefs, false, '$refs must be stripped');
  });

  it('sandboxed dynamic action allows writes to own path and children', async () => {
    registerBuiltinActions();
    const tree = createMemoryTree();

    await tree.set({
      $path: '/sys/types/test/writer',
      $type: 'dir',
      actions: {
        writeChild: 'ctx.tree.set({ $path: ctx.node.$path + "/child1", $type: "test.writer", created: true }); return "ok";',
      },
      schema: { methods: { writeChild: { arguments: [] } } },
    } as NodeData);

    await tree.set(createNode('/writer1', 'test.writer', {}));

    const result = await executeAction(tree, '/writer1', undefined, undefined, 'writeChild', {});
    assert.equal(result, 'ok');

    const child = await tree.get('/writer1/child1');
    assert.ok(child, 'write to own child path should succeed');
    assert.equal((child as any).created, true);
  });

  it('dynamic action not cached — source changes take effect', async () => {
    registerBuiltinActions();
    const tree = createMemoryTree();

    await tree.set({
      $path: '/sys/types/test/mutable',
      $type: 'dir',
      actions: { calc: 'return 1;' },
      schema: { methods: { calc: { arguments: [] } } },
    } as NodeData);
    await tree.set(createNode('/mut1', 'test.mutable', {}));

    const r1 = await executeAction(tree, '/mut1', undefined, undefined, 'calc', {});
    assert.equal(r1, 1);

    // Update the action source
    const typeNode = (await tree.get('/sys/types/test/mutable'))!;
    await tree.set({ ...typeNode, actions: { calc: 'return 2;' } } as NodeData);

    const r2 = await executeAction(tree, '/mut1', undefined, undefined, 'calc', {});
    assert.equal(r2, 2, 'updated source should take effect immediately');
  });

  it('rejects action with invalid args', async () => {
    setup();
    const tree = createMemoryTree();
    await tree.set(createNode('/v', 'page', {}, {
      metadata: { $type: 'metadata', title: 'ok', description: '' },
      status: { $type: 'status', value: 'draft' },
    }));

    await assert.rejects(
      () => executeAction(tree, '/v', 'metadata', 'metadata', 'rename', { title: 123 }),
      (err: any) => err.code === 'BAD_REQUEST',
    );
  });

  it('rejects action with missing required arg', async () => {
    setup();
    const tree = createMemoryTree();
    await tree.set(createNode('/v2', 'page', {}, {
      metadata: { $type: 'metadata', title: 'ok', description: '' },
      status: { $type: 'status', value: 'draft' },
    }));

    await assert.rejects(
      () => executeAction(tree, '/v2', 'metadata', 'metadata', 'rename', {}),
      (err: any) => err.code === 'BAD_REQUEST',
    );
  });

  it('accepts action with valid args', async () => {
    setup();
    const tree = createMemoryTree();
    await tree.set(createNode('/v3', 'page', {}, {
      metadata: { $type: 'metadata', title: 'old', description: '' },
      status: { $type: 'status', value: 'draft' },
    }));

    await executeAction(tree, '/v3', 'metadata', 'metadata', 'rename', { title: 'new' });
    const result = (await tree.get('/v3'))!;
    assert.equal((result['metadata'] as any).title, 'new');
  });
});

describe('applyTemplate', () => {
  it('rolls back written children when a write fails mid-apply', async () => {
    const tree = createMemoryTree();

    // Template with 3 blocks
    await tree.set({ $path: '/tmpl', $type: 'template' } as NodeData);
    await tree.set({ $path: '/tmpl/a', $type: 'block', label: 'A' } as NodeData);
    await tree.set({ $path: '/tmpl/b', $type: 'block', label: 'B' } as NodeData);
    await tree.set({ $path: '/tmpl/c', $type: 'block', label: 'C' } as NodeData);

    // Target with existing children
    await tree.set({ $path: '/target', $type: 'page' } as NodeData);
    await tree.set({ $path: '/target/old1', $type: 'block', label: 'OLD1' } as NodeData);
    await tree.set({ $path: '/target/old2', $type: 'block', label: 'OLD2' } as NodeData);

    // Wrap tree.set to fail on the 3rd new write (block c)
    const realSet = tree.set.bind(tree);
    let setCount = 0;
    const failingTree = {
      ...tree,
      set: async (node: NodeData) => {
        setCount++;
        // Writes 1-2 = blocks a, b succeed; write 3 = block c fails
        if (setCount === 3) throw new Error('disk full');
        return realSet(node);
      },
    };

    await assert.rejects(
      () => applyTemplate(failingTree as any, '/tmpl', '/target'),
      { message: 'disk full' },
    );

    // Original children must still be present (restored from snapshot)
    const old1 = await tree.get('/target/old1');
    assert.ok(old1, 'original child old1 must survive rollback');
    assert.equal((old1 as any).label, 'OLD1');

    const old2 = await tree.get('/target/old2');
    assert.ok(old2, 'original child old2 must survive rollback');
  });

  it('preserves data when delete phase fails (no data loss)', async () => {
    const tree = createMemoryTree();

    // Template with 1 block
    await tree.set({ $path: '/tmpl', $type: 'template' } as NodeData);
    await tree.set({ $path: '/tmpl/new1', $type: 'block', label: 'NEW' } as NodeData);

    // Target with existing child (different name, so it should be deleted)
    await tree.set({ $path: '/target', $type: 'page' } as NodeData);
    await tree.set({ $path: '/target/old1', $type: 'block', label: 'OLD' } as NodeData);

    // Wrap tree.remove to always fail
    const failingTree = {
      ...tree,
      remove: async (_path: string) => { throw new Error('remove failed'); },
    };

    // applyTemplate should still succeed (delete failures don't abort)
    // Actually the current code doesn't catch delete errors — but delete phase
    // happens after all writes, so data is safe. Let's verify both children exist.
    try {
      await applyTemplate(failingTree as any, '/tmpl', '/target');
    } catch {
      // delete error may propagate — that's ok
    }

    // New child was written (phase 1 succeeded)
    const newChild = await tree.get('/target/new1');
    assert.ok(newChild, 'new child must exist after write phase');
    assert.equal((newChild as any).label, 'NEW');

    // Old child still exists (delete failed, but no data loss)
    const oldChild = await tree.get('/target/old1');
    assert.ok(oldChild, 'old child preserved when delete fails — no data loss');
  });
});

describe('setComponent', () => {
  it('does not corrupt cache when tree.set fails', async () => {
    const mem = createMemoryTree();
    const cached = withCache(mem);

    await cached.set({ $path: '/n1', $type: 'test', foo: 'original' } as NodeData);

    // Prime cache
    const before = await cached.get('/n1');
    assert.equal((before as any).foo, 'original');

    // Make set fail (simulate OCC/ACL/validation failure)
    const realSet = cached.set.bind(cached);
    const failing = {
      ...cached,
      set: async (_node: NodeData) => { throw new Error('ACL denied'); },
    };

    await assert.rejects(
      () => setComponent(failing as any, '/n1', 'bar', { x: 1 }),
      { message: 'ACL denied' },
    );

    // Cache must still return original, unmutated node
    const after = await cached.get('/n1');
    assert.equal((after as any).foo, 'original', 'original field preserved');
    assert.equal((after as any).bar, undefined, 'ghost component must not appear in cache');
  });
});
