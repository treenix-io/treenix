import { registerType } from '#comp';
import { getActionNeeds, parseNeedPattern } from '#comp/needs';
import { clearRegistry } from '#testing';
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

describe('needs registration', () => {
  beforeEach(() => clearRegistry());

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
