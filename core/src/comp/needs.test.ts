import { registerType } from '#comp';
import { collectDeps, getActionNeeds, parseNeedPattern } from '#comp/needs';
import { createNode, register } from '#core';
import { clearRegistry } from '#testing';
import { executeAction } from '#server/actions';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// ── Test classes ──

class Status {
  value = 'draft';
  publish() { this.value = 'published'; }
}

class Payment {
  amount = 0;
  settled = false;
}

class Delivery {
  status = 'pending';
}

// ── Tests ──

describe('parseNeedPattern', () => {
  it('sibling', () => {
    const spec = parseNeedPattern('payment');
    assert.deepEqual(spec, { kind: 'sibling', name: 'payment', key: 'payment' });
  });

  it('field-ref', () => {
    const spec = parseNeedPattern('@warehouseRef');
    assert.deepEqual(spec, { kind: 'field-ref', field: 'warehouseRef', key: 'warehouseRef' });
  });

  it('relative path', () => {
    const spec = parseNeedPattern('./config');
    assert.deepEqual(spec, { kind: 'path', path: './config', key: 'config' });
  });

  it('parent-relative path', () => {
    const spec = parseNeedPattern('../settings');
    assert.deepEqual(spec, { kind: 'path', path: '../settings', key: 'settings' });
  });

  it('absolute path', () => {
    const spec = parseNeedPattern('/sys/config');
    assert.deepEqual(spec, { kind: 'path', path: '/sys/config', key: 'config' });
  });

  it('children pattern', () => {
    const spec = parseNeedPattern('./items/*');
    assert.deepEqual(spec, { kind: 'children', path: './items', key: 'items' });
  });
});

describe('per-action needs', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('registration needs compile per action', () => {
    class Article {
      title = '';
      publish() { this.title = 'published'; }
      ship() { this.title = 'shipped'; }
    }

    registerType('t.article', Article, {
      needs: { publish: ['status'], ship: ['status', 'delivery'] },
    });
    registerType('t.status', Status);
    registerType('t.delivery', Delivery);

    const publishNeeds = getActionNeeds('t.article', 'publish');
    assert.equal(publishNeeds.length, 1);
    assert.equal(publishNeeds[0].key, 'status');

    const shipNeeds = getActionNeeds('t.article', 'ship');
    assert.equal(shipNeeds.length, 2);
  });

  it('registration needs supports a * fallback', () => {
    class Meta { title = ''; rename() {} }
    registerType('t.meta', Meta, { needs: { '*': ['status'] } });
    registerType('t.status', Status);

    // '*' fallback applies to any action
    const needs = getActionNeeds('t.meta', 'rename');
    assert.equal(needs.length, 1);
    assert.equal(needs[0].key, 'status');
  });

  it('per-action overrides fallback', () => {
    class Article {
      title = '';
      publish() {}
      archive() {}
    }

    registerType('t.article', Article, {
      needs: { '*': ['status'], publish: ['payment'] },
    });
    registerType('t.status', Status);
    registerType('t.payment', Payment);

    // publish: explicit per-action
    assert.equal(getActionNeeds('t.article', 'publish')[0].key, 'payment');
    // archive: falls back to '*'
    assert.equal(getActionNeeds('t.article', 'archive')[0].key, 'status');
  });
});

describe('collectDeps', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('sibling deps from same node', async () => {
    class Article {
      title = '';
      publish(_d: unknown, deps: any) {
        this.title = 'new';
        deps.status.value = 'published';
      }
    }

    registerType('t.article', Article, { needs: { publish: ['status'] } });
    registerType('t.status', Status);

    const tree = createMemoryTree();
    const node = createNode('/a', 'page', {}, {
      article: { $type: 't.article', title: 'old' },
      status: { $type: 't.status', value: 'draft' },
    });

    const deps = await collectDeps(node, 'article', 'publish', tree);
    assert.equal(Object.keys(deps).length, 1);
    assert.equal((deps.status as any).value, 'draft');
  });

  it('@fieldRef resolves to remote node', async () => {
    class Connector {
      targetRef = '/config/warehouse';
      check() {}
    }

    registerType('t.connector', Connector, { needs: { check: ['@targetRef'] } });

    const tree = createMemoryTree();
    await tree.set(createNode('/config/warehouse', 'warehouse', { capacity: 100 }));
    const node = createNode('/order/1', 'page', {}, {
      connector: { $type: 't.connector', targetRef: '/config/warehouse' },
    });

    const deps = await collectDeps(node, 'connector', 'check', tree);
    assert.equal((deps.targetRef as any).$path, '/config/warehouse');
    assert.equal((deps.targetRef as any).capacity, 100);
  });

  it('relative path ./child resolves', async () => {
    class Parent {
      run() {}
    }

    registerType('t.parent', Parent, { needs: { run: ['./config'] } });

    const tree = createMemoryTree();
    await tree.set(createNode('/app/config', 'cfg', { debug: true }));
    const node = createNode('/app', 'dir', {}, {
      parent: { $type: 't.parent' },
    });

    const deps = await collectDeps(node, 'parent', 'run', tree);
    assert.equal((deps.config as any).$path, '/app/config');
    assert.equal((deps.config as any).debug, true);
  });

  it('parent-relative path ../sibling resolves', async () => {
    class Child {
      run() {}
    }

    registerType('t.child', Child, { needs: { run: ['../settings'] } });

    const tree = createMemoryTree();
    await tree.set(createNode('/app/settings', 'cfg', { lang: 'en' }));
    const node = createNode('/app/module', 'dir', {}, {
      child: { $type: 't.child' },
    });

    const deps = await collectDeps(node, 'child', 'run', tree);
    assert.equal((deps.settings as any).$path, '/app/settings');
    assert.equal((deps.settings as any).lang, 'en');
  });

  it('absolute path resolves', async () => {
    class Widget {
      init() {}
    }

    registerType('t.widget', Widget, { needs: { init: ['/sys/config'] } });

    const tree = createMemoryTree();
    await tree.set(createNode('/sys/config', 'cfg', { version: 2 }));
    const node = createNode('/ui/widget', 'dir', {}, {
      widget: { $type: 't.widget' },
    });

    const deps = await collectDeps(node, 'widget', 'init', tree);
    assert.equal((deps.config as any).$path, '/sys/config');
    assert.equal((deps.config as any).version, 2);
  });

  it('./children/* returns array of child nodes', async () => {
    class List {
      report() {}
    }

    registerType('t.list', List, { needs: { report: ['./items/*'] } });

    const tree = createMemoryTree();
    await tree.set(createNode('/orders/1/items/a', 'item', { name: 'apple' }));
    await tree.set(createNode('/orders/1/items/b', 'item', { name: 'banana' }));
    const node = createNode('/orders/1', 'order', {}, {
      list: { $type: 't.list' },
    });

    const deps = await collectDeps(node, 'list', 'report', tree);
    assert.ok(Array.isArray(deps.items));
    assert.equal((deps.items as any[]).length, 2);
  });

  it('mixed deps: siblings + cross-node', async () => {
    class OrderStatus {
      value = 'draft';
      warehouseRef = '/config/wh';

      advance() {}
    }

    registerType('t.order-status', OrderStatus, {
      needs: { advance: ['payment', '@warehouseRef', './items/*'] },
    });
    registerType('t.payment', Payment);

    const tree = createMemoryTree();
    await tree.set(createNode('/config/wh', 'warehouse', { capacity: 50 }));
    await tree.set(createNode('/order/1/items/x', 'item', { qty: 3 }));

    const node = createNode('/order/1', 'order', {}, {
      status: { $type: 't.order-status', value: 'draft', warehouseRef: '/config/wh' },
      payment: { $type: 't.payment', amount: 100, settled: false },
    });

    const deps = await collectDeps(node, 'status', 'advance', tree);

    // sibling
    assert.equal((deps.payment as any).amount, 100);
    // field-ref
    assert.equal((deps.warehouseRef as any).$path, '/config/wh');
    // children
    assert.ok(Array.isArray(deps.items));
    assert.equal((deps.items as any[]).length, 1);
  });

  it('empty needs = no deps', async () => {
    class Simple {
      run() {}
    }

    registerType('t.simple', Simple, { needs: { run: [] } });
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, { simple: { $type: 't.simple' } });

    const deps = await collectDeps(node, 'simple', 'run', tree);
    assert.deepEqual(deps, {});
  });

  it('no registration needs = no deps', async () => {
    class Plain { run() {} }
    registerType('t.plain', Plain);
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, { plain: { $type: 't.plain' } });

    const deps = await collectDeps(node, 'plain', 'run', tree);
    assert.deepEqual(deps, {});
  });

  // ── Fail-loud ──

  it('throws on missing sibling', async () => {
    class NeedsMissing {
      run() {}
    }
    registerType('t.needs-missing', NeedsMissing, { needs: { run: ['nonexistent'] } });
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, { comp: { $type: 't.needs-missing' } });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws on missing @fieldRef target', async () => {
    class BadRef {
      targetRef = '/nowhere';
      run() {}
    }
    registerType('t.bad-ref', BadRef, { needs: { run: ['@targetRef'] } });
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, {
      comp: { $type: 't.bad-ref', targetRef: '/nowhere' },
    });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws on missing path dep', async () => {
    class BadPath {
      run() {}
    }
    registerType('t.bad-path', BadPath, { needs: { run: ['/missing/node'] } });
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, { comp: { $type: 't.bad-path' } });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws on @field that is not a string', async () => {
    class BadField {
      targetRef = 42;
      run() {}
    }
    registerType('t.bad-field', BadField, { needs: { run: ['@targetRef'] } });
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, {
      comp: { $type: 't.bad-field', targetRef: 42 },
    });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws at registration on duplicate dep keys', () => {
    class DupKeys {
      run() {}
    }
    assert.throws(() => registerType('t.dup', DupKeys, {
      needs: { run: ['payment', '/other/payment'] },
    }), /Duplicate need key/);
  });

  it('throws before publishing when needs names a missing action', () => {
    class Article { publish() {} }
    assert.throws(() => registerType('t.bad-needs', Article, {
      needs: { missing: ['status'] } as any,
    }), /missing action/);
    assert.equal(getActionNeeds('t.bad-needs', 'publish').length, 0);
  });
});

describe('executeAction with deps', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('per-action deps injected into method via executeAction', async () => {
    class Article {
      title = '';

      publishAndRename({ title }: { title: string }, deps: { status: any }) {
        this.title = title;
        deps.status.value = 'published';
      }
    }

    registerType('t.article', Article, { needs: { publishAndRename: ['status'] } });
    register('t.article', 'schema', () => ({
      $id: 't.article', title: 'Article', type: 'object' as const,
      properties: { title: { type: 'string' } },
      methods: { publishAndRename: { arguments: [{ name: 'data', type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }] } },
    }));
    registerType('t.status', Status);

    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'page', {}, {
      article: { $type: 't.article', title: 'old' },
      status: { $type: 't.status', value: 'draft' },
    }));

    await executeAction(tree, '/a', 't.article', undefined, 'publishAndRename', { title: 'new' });

    const result = (await tree.get('/a'))!;
    assert.equal((result['#article'] as any).title, 'new');
    assert.equal((result['#status'] as any).value, 'published');
  });

  it('different actions get different deps', async () => {
    class Processor {
      value = '';

      quick(_d: unknown, deps: any) {
        this.value = `status=${deps.status.value}`;
      }

      full(_d: unknown, deps: any) {
        this.value = `status=${deps.status.value},amount=${deps.payment.amount}`;
      }
    }

    registerType('t.processor', Processor, {
      needs: { quick: ['status'], full: ['status', 'payment'] },
    });
    register('t.processor', 'schema', () => ({
      $id: 't.processor', title: 'Processor', type: 'object' as const,
      properties: { value: { type: 'string' } },
      methods: { quick: { arguments: [] }, full: { arguments: [] } },
    }));
    registerType('t.status', Status);
    registerType('t.payment', Payment);

    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'page', {}, {
      processor: { $type: 't.processor', value: '' },
      status: { $type: 't.status', value: 'active' },
      payment: { $type: 't.payment', amount: 500, settled: false },
    }));

    await executeAction(tree, '/p', 't.processor', undefined, 'quick', {});
    let result = (await tree.get('/p'))!;
    assert.equal((result['#processor'] as any).value, 'status=active');

    await executeAction(tree, '/p', 't.processor', undefined, 'full', {});
    result = (await tree.get('/p'))!;
    assert.equal((result['#processor'] as any).value, 'status=active,amount=500');
  });

  it('cross-node @fieldRef in executeAction', async () => {
    class Connector {
      targetRef = '';
      result = '';

      fetch(_d: unknown, deps: any) {
        this.result = deps.targetRef.$path;
      }
    }

    registerType('t.connector', Connector, { needs: { fetch: ['@targetRef'] } });
    register('t.connector', 'schema', () => ({
      $id: 't.connector', title: 'Connector', type: 'object' as const,
      properties: { targetRef: { type: 'string' }, result: { type: 'string' } },
      methods: { fetch: { arguments: [] } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/config/wh', 'warehouse', { capacity: 50 }));
    await tree.set(createNode('/order/1', 'page', {}, {
      connector: { $type: 't.connector', targetRef: '/config/wh', result: '' },
    }));

    await executeAction(tree, '/order/1', 't.connector', undefined, 'fetch', {});

    const result = (await tree.get('/order/1'))!;
    assert.equal((result['#connector'] as any).result, '/config/wh');
  });
});
