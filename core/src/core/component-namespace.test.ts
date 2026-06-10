import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compKey, compName, createNode, getComponent, getComponentByName,
  getComponentField, getComponents, isCompKey, removeComponent,
} from './component';

describe('compKey / compName', () => {
  it('prefixes and strips symmetrically', () => {
    assert.equal(compKey('run'), '#run');
    assert.equal(compName('#run'), 'run');
    assert.equal(compName('run'), 'run');
  });

  it('compKey is idempotent — never ##', () => {
    assert.equal(compKey('#run'), '#run');
  });

  it('rejects empty and dotted names', () => {
    assert.throws(() => compKey(''));
    assert.throws(() => compKey('#'));
    assert.throws(() => compKey('run.status'));
    assert.throws(() => compName('#a.b'));
  });

  it('rejects $-prefixed and double-# names', () => {
    assert.throws(() => compKey('$acl'));
    assert.throws(() => compKey('##run'));
  });

  it('isCompKey classifies by prefix only', () => {
    assert.ok(isCompKey('#run'));
    assert.ok(!isCompKey('run'));
    assert.ok(!isCompKey('$type'));
  });
});

describe('makeNode — components land under #', () => {
  it('prefixes component-arg keys', () => {
    const node = createNode('/t', 'task', { title: 'x' }, {
      status: { $type: 'status', value: 'open' },
    });
    assert.equal(node['#status'].value, 'open');
    assert.equal(node.title, 'x');
    assert.ok(!('status' in node));
  });

  it('rejects component values without $type', () => {
    assert.throws(() => createNode('/t', 'task', {}, { broken: { value: 1 } as never }));
  });

  it('rejects #-prefixed data keys — bare fields must stay bare', () => {
    assert.throws(() => createNode('/t', 'task', { '#sneaky': 1 }));
  });
});

describe('strict classification — prefix, not $type sniffing', () => {
  it('a bare value carrying $type is plain data, not a component', () => {
    // The escape hatch the old in-band detection never had: an agent storing
    // a node snapshot in a data field no longer attaches a component.
    const node = createNode('/log', 'log.entry', {
      snapshot: { $type: 'crm.deal', $path: '/clients/acme/d1', amount: 5 },
    });
    assert.equal(getComponent(node, 'crm.deal'), undefined);
    assert.deepEqual(getComponents(node).map(([k]) => k), ['']);
    assert.equal(getComponentByName(node, 'snapshot'), undefined);
  });

  it('getComponentByName accepts bare or # name, reads #-key only', () => {
    const node = createNode('/t', 'task', {}, { run: { $type: 'flow.run', n: 1 } });
    assert.equal(getComponentByName(node, 'run')?.n, 1);
    assert.equal(getComponentByName(node, '#run')?.n, 1);
    assert.equal(getComponentByName(node, 'missing'), undefined);
  });

  it('malformed #-entry throws on access', () => {
    const node = createNode('/t', 'task');
    (node as Record<string, unknown>)['#broken'] = { value: 1 };
    assert.throws(() => getComponentByName(node, 'broken'), /Malformed component entry/);
    assert.throws(() => getComponents(node), /Malformed component entry/);
  });

  it('getComponentField returns the storage key', () => {
    const node = createNode('/t', 'task', {}, { run: { $type: 'flow.run', n: 1 } });
    const byName = getComponentField(node, 'flow.run', 'run');
    assert.deepEqual(byName?.[1], '#run');
    const byScan = getComponentField(node, 'flow.run');
    assert.deepEqual(byScan?.[1], '#run');
  });

  it('node-level main component still resolves with empty field key', () => {
    const node = createNode('/t', 'crm.deal', { amount: 5 });
    const found = getComponentField(node, 'crm.deal');
    assert.equal(found?.[1], '');
    assert.equal(found?.[0], node);
  });

  it('removeComponent removes only the # form', () => {
    const node = createNode('/t', 'task', {}, { tag: { $type: 'tag' } });
    assert.equal(removeComponent(node, 'tag'), true);
    assert.equal(removeComponent(node, 'tag'), false);

    const legacyish = createNode('/t2', 'task', { tag2: 'plain' });
    (legacyish as Record<string, unknown>).tag = { $type: 'tag' }; // bare = data now
    assert.equal(removeComponent(legacyish, 'tag'), false);
    assert.ok(legacyish.tag, 'bare data field untouched');
  });
});
