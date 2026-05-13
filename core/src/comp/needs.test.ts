import { registerType } from '#comp';
import { collectDeps, collectSiblings, getActionNeeds, parseNeedPattern } from '#comp/needs';
import { createNode, register } from '#core';
import { clearRegistry } from '#core/index.test';
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

  it('static needs registers per-action', () => {
    class Article {
      title = '';
      static needs = {
        publish: ['status'],
        ship: ['status', 'delivery'],
      };
      publish() { this.title = 'published'; }
      ship() { this.title = 'shipped'; }
    }

    registerType('t.article', Article);
    registerType('t.status', Status);
    registerType('t.delivery', Delivery);

    const publishNeeds = getActionNeeds('t.article', 'publish');
    assert.equal(publishNeeds.length, 1);
    assert.equal(publishNeeds[0].key, 'status');

    const shipNeeds = getActionNeeds('t.article', 'ship');
    assert.equal(shipNeeds.length, 2);
  });

  it('opts.needs registers as * fallback', () => {
    class Meta { title = ''; rename() {} }
    registerType('t.meta', Meta, { needs: ['status'] });
    registerType('t.status', Status);

    // '*' fallback applies to any action
    const needs = getActionNeeds('t.meta', 'rename');
    assert.equal(needs.length, 1);
    assert.equal(needs[0].key, 'status');
  });

  it('per-action overrides fallback', () => {
    class Article {
      title = '';
      static needs = { publish: ['payment'] };
      publish() {}
      archive() {}
    }

    registerType('t.article', Article, { needs: ['status'] });
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
      static needs = { publish: ['status'] };
      publish(_d: unknown, deps: any) {
        this.title = 'new';
        deps.status.value = 'published';
      }
    }

    registerType('t.article', Article);
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
      static needs = { check: ['@targetRef'] };
      check() {}
    }

    registerType('t.connector', Connector);

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
      static needs = { run: ['./config'] };
      run() {}
    }

    registerType('t.parent', Parent);

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
      static needs = { run: ['../settings'] };
      run() {}
    }

    registerType('t.child', Child);

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
      static needs = { init: ['/sys/config'] };
      init() {}
    }

    registerType('t.widget', Widget);

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
      static needs = { report: ['./items/*'] };
      report() {}
    }

    registerType('t.list', List);

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

      static needs = {
        advance: ['payment', '@warehouseRef', './items/*'],
      };
      advance() {}
    }

    registerType('t.order-status', OrderStatus);
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
      static needs = { run: [] };
      run() {}
    }

    registerType('t.simple', Simple);
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, { simple: { $type: 't.simple' } });

    const deps = await collectDeps(node, 'simple', 'run', tree);
    assert.deepEqual(deps, {});
  });

  it('no static needs + no opts.needs = no deps', async () => {
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
      static needs = { run: ['nonexistent'] };
      run() {}
    }
    registerType('t.needs-missing', NeedsMissing);
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, { comp: { $type: 't.needs-missing' } });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws on missing @fieldRef target', async () => {
    class BadRef {
      targetRef = '/nowhere';
      static needs = { run: ['@targetRef'] };
      run() {}
    }
    registerType('t.bad-ref', BadRef);
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, {
      comp: { $type: 't.bad-ref', targetRef: '/nowhere' },
    });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws on missing path dep', async () => {
    class BadPath {
      static needs = { run: ['/missing/node'] };
      run() {}
    }
    registerType('t.bad-path', BadPath);
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, { comp: { $type: 't.bad-path' } });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws on @field that is not a string', async () => {
    class BadField {
      targetRef = 42;
      static needs = { run: ['@targetRef'] };
      run() {}
    }
    registerType('t.bad-field', BadField as any);
    const tree = createMemoryTree();
    const node = createNode('/x', 'dir', {}, {
      comp: { $type: 't.bad-field', targetRef: 42 },
    });

    await assert.rejects(() => collectDeps(node, 'comp', 'run', tree));
  });

  it('throws at registration on duplicate dep keys', () => {
    class DupKeys {
      static needs = { run: ['payment', '/other/payment'] };
      run() {}
    }
    assert.throws(() => registerType('t.dup', DupKeys), /Duplicate need key/);
  });
});

describe('collectSiblings backward compat', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('opts.needs still works via collectSiblings', () => {
    class Meta { title = ''; rename() {} }
    registerType('t.meta', Meta, { needs: ['status'] });
    registerType('t.status', Status);

    const node = createNode('/p', 'page', {}, {
      meta: { $type: 't.meta', title: 'old' },
      status: { $type: 't.status', value: 'draft' },
    });

    const siblings = collectSiblings(node, 'meta');
    assert.equal(Object.keys(siblings).length, 1);
    assert.equal((siblings.status as any).value, 'draft');
  });
});

describe('executeAction with deps', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('per-action deps injected into method via executeAction', async () => {
    class Article {
      title = '';

      static needs = {
        publishAndRename: ['status'],
      };

      publishAndRename({ title }: { title: string }, deps: { status: any }) {
        this.title = title;
        deps.status.value = 'published';
      }
    }

    registerType('t.article', Article);
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
    assert.equal((result['article'] as any).title, 'new');
    assert.equal((result['status'] as any).value, 'published');
  });

  it('different actions get different deps', async () => {
    class Processor {
      value = '';

      static needs = {
        quick: ['status'],
        full: ['status', 'payment'],
      };

      quick(_d: unknown, deps: any) {
        this.value = `status=${deps.status.value}`;
      }

      full(_d: unknown, deps: any) {
        this.value = `status=${deps.status.value},amount=${deps.payment.amount}`;
      }
    }

    registerType('t.processor', Processor);
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
    assert.equal((result['processor'] as any).value, 'status=active');

    await executeAction(tree, '/p', 't.processor', undefined, 'full', {});
    result = (await tree.get('/p'))!;
    assert.equal((result['processor'] as any).value, 'status=active,amount=500');
  });

  it('cross-node @fieldRef in executeAction', async () => {
    class Connector {
      targetRef = '';
      result = '';

      static needs = { fetch: ['@targetRef'] };

      fetch(_d: unknown, deps: any) {
        this.result = deps.targetRef.$path;
      }
    }

    registerType('t.connector', Connector);
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
    assert.equal((result['connector'] as any).result, '/config/wh');
  });
});
