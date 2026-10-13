import { assertSafePath, basename, dirname, isChildPath, join } from '#core/path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSafeKey,
  assertValidType,
  createNode,
  getComponent,
  getComponentByName,
  getComponents,
  isComponent,
  isRef,
  isSafeKey,
  ref,
  removeComponent,
  safeJsonParse,
} from './index';

describe('Node', () => {
  it('creates with type and path', () => {
    const node = createNode('/tasks/1', 'task');
    assert.equal(node.$path, '/tasks/1');
    assert.equal(node.$type, 't.task');
  });

  it('creates with components', () => {
    const node = createNode('/tasks/1', 'task', {}, {
      info: { $type: 'task', status: 'open' },
      budget: { $type: 'money', amount: 100, currency: 'USD' },
    });
    assert.equal(node['#info'].$type, 'task');
    assert.equal(node['#budget'].amount, 100);
  });

  it('rejects $ prefix in component names', () => {
    assert.throws(() => createNode('/x', 'x', {}, { $bad: { $type: 'x' } }));
  });
});

describe('Component access', () => {
  const node = createNode('/tasks/1', 'task', {}, {
    budget: { $type: 'money', amount: 100, currency: 'USD' },
    estimate: { $type: 'money', amount: 200, currency: 'USD' },
  });

  it('get by type — node-level match', () => {
    // node.$type is 't.task', getComponent('task') normalizes and matches
    const comp = getComponent(node, 'task');
    assert.equal(comp, node);
  });

  it('get by type — named component', () => {
    const comp = getComponent(node, 'money');
    assert.ok(comp);
    assert.equal((comp as any).amount, 100); // first match: budget
  });

  it('get by type with field filter', () => {
    const comp = getComponent(node, 'money', 'estimate');
    assert.ok(comp);
    assert.equal((comp as any).amount, 200);
  });

  it('returns undefined for missing type', () => {
    assert.equal(getComponent(node, 'nope'), undefined);
  });

  it('returns undefined for wrong type at field', () => {
    assert.equal(getComponent(node, 'task', 'budget'), undefined);
  });

  it('find all by type', () => {
    const moneys = getComponents(node, 'money');
    assert.equal(moneys.length, 2);
    // Accessors return STORAGE keys; display layers apply compName().
    assert.deepEqual(moneys.map(([name]) => name).sort(), ['#budget', '#estimate']);
  });

  it('isComponent type guard', () => {
    assert.ok(isComponent(node['#budget']));
    assert.ok(!isComponent((node as any)['missing']));
    assert.ok(!isComponent('string'));
    assert.ok(!isComponent(null));
  });

  it('iterates the main component first, then ($order, name), whatever the key order', () => {
    const n = createNode('/x', 'x', {}, {
      c: { $type: 'money', $order: 'a' },
      b: { $type: 'tag', $order: 'V' },
      a: { $type: 'money', $order: 'a' },
      d: { $type: 'tag', $order: 'U' },
    });

    assert.deepEqual(getComponents(n).map(([name]) => name), ['', '#d', '#b', '#a', '#c']);
    assert.deepEqual(getComponents(n, 'money').map(([name]) => name), ['#a', '#c']);
  });

  it('components without $order come before ordered ones, by name', () => {
    const n = createNode('/x', 'x', {}, {
      ordered: { $type: 'tag', $order: '1' },
      zeta: { $type: 'tag' },
      alpha: { $type: 'tag' },
    });
    n.$order = 'z';

    assert.deepEqual(getComponents(n).map(([name]) => name), ['', '#alpha', '#zeta', '#ordered']);
  });

  it('getComponent by type is the first of getComponents, whatever the key order', () => {
    const comps: Record<string, { $type: string; $order?: string }> = {
      m1: { $type: 'money', $order: 'b' }, m2: { $type: 'money', $order: 'a' }, m3: { $type: 'money', $order: 'a' },
      m4: { $type: 'money' }, t1: { $type: 'tag' },
    };
    const names = Object.keys(comps);

    for (let shift = 0; shift < names.length; shift++) {
      const rotated = [...names.slice(shift), ...names.slice(0, shift)];
      const n = createNode('/x', 'x', {}, Object.fromEntries(rotated.map((name) => [name, comps[name]])));

      assert.equal(getComponent(n, 'money'), getComponents(n, 'money')[0][1], rotated.join());
      assert.equal(getComponent(n, 'money'), comps.m4, rotated.join());
    }
  });

  it('a component with a non-string $order is a malformed entry: every lookup that meets it throws', () => {
    const n = createNode('/x', 'x', {}, { a: { $type: 'tag', $order: 5 }, b: { $type: 'tag' } });
    const alone = createNode('/y', 'y', {}, { a: { $type: 'tag', $order: 5 } });

    assert.throws(() => getComponents(n));
    assert.throws(() => getComponent(n, 'tag'));
    assert.throws(() => getComponent(alone, 'tag'));
    assert.throws(() => getComponentByName(alone, 'a'));
  });

  it('set and remove', () => {
    const n = createNode('/x', 'x');
    (n as any)['#tag'] = { $type: 'tag', value: 'urgent' };
    assert.ok(getComponent(n, 'tag'));
    assert.equal(removeComponent(n, 'tag'), true);
    assert.equal(getComponent(n, 'tag'), undefined);
    assert.equal(removeComponent(n, 'tag'), false);
  });
});

describe('Ref', () => {
  it('creates ref', () => {
    const r = ref('/users/bob');
    assert.equal(r.$type, 'ref');
    assert.equal(r.$ref, '/users/bob');
  });

  it('detects ref', () => {
    assert.equal(isRef(ref('/x')), true);
    assert.equal(isRef({ $type: 'task' }), false);
    assert.equal(isRef(null), false);
    assert.equal(isRef('string'), false);
  });
});

describe('Path utils', () => {
  it('parentPath', () => {
    assert.equal(dirname('/'), null);
    assert.equal(dirname('/tasks'), '/');
    assert.equal(dirname('/tasks/123'), '/tasks');
    assert.equal(dirname('/a/b/c'), '/a/b');
  });

  it('nodeName', () => {
    assert.equal(basename('/tasks/123'), '123');
    assert.equal(basename('/tasks'), 'tasks');
  });

  it('childPath', () => {
    assert.equal(join('/', 'tasks'), '/tasks');
    assert.equal(join('/tasks', '123'), '/tasks/123');
  });

  it('isChildPath direct', () => {
    assert.equal(isChildPath('/tasks', '/tasks/123'), true);
    assert.equal(isChildPath('/tasks', '/tasks/123/sub'), false);
    assert.equal(isChildPath('/tasks', '/tasks'), false);
    assert.equal(isChildPath('/', '/tasks'), true);
    assert.equal(isChildPath('/', '/tasks/123'), false);
  });

  it('isChildPath recursive', () => {
    assert.equal(isChildPath('/tasks', '/tasks/123/sub', false), true);
    assert.equal(isChildPath('/', '/tasks/123', false), true);
  });

  // Regression: /board must not match /boards (prefix overlap without separator)
  it('isChildPath rejects prefix overlap without separator', () => {
    assert.equal(isChildPath('/board', '/boards'), false);
    assert.equal(isChildPath('/board', '/boards/test'), false);
    assert.equal(isChildPath('/board', '/boards/test', false), false);
    assert.equal(isChildPath('/board', '/board/real'), true);
    assert.equal(isChildPath('/board', '/board/real/deep', false), true);
  });
});



describe('assertSafePath (F03)', () => {
  it('accepts valid paths', () => {
    assertSafePath('/');
    assertSafePath('/board');
    assertSafePath('/board/task-1');
    assertSafePath('/a/b/c/d');
  });

  it('rejects path without leading slash', () => {
    assert.throws(() => assertSafePath('board'), /must start with/);
  });

  it('rejects traversal (..)', () => {
    assert.throws(() => assertSafePath('/board/../admin'), /traversal/);
    assert.throws(() => assertSafePath('/..'), /traversal/);
  });

  it('rejects null bytes', () => {
    assert.throws(() => assertSafePath('/test\0/evil'), /null byte/);
  });

  it('rejects double slashes', () => {
    assert.throws(() => assertSafePath('//admin'), /double slash/);
    assert.throws(() => assertSafePath('/board//task'), /double slash/);
  });

  it('rejects backslash', () => {
    assert.throws(() => assertSafePath('/board\\admin'), /backslash/);
    assert.throws(() => assertSafePath('\\board'), /must start with/);
  });

  it('rejects percent-escaped sequences', () => {
    // %2e%2e/ → ../ if decoded later by some downstream
    assert.throws(() => assertSafePath('/board/%2e%2e/admin'), /percent/);
    // %2f → / could collapse segments
    assert.throws(() => assertSafePath('/board%2fadmin'), /percent/);
    // any percent-escape rejected — paths are stored literally, no encoding
    assert.throws(() => assertSafePath('/board/%20task'), /percent/);
  });

  it('rejects URI-reserved delimiters (? and #)', () => {
    // '?' (query) and '#' (fragment / component-key) are URI delimiters — a raw node $path
    // must never contain them (blocks mount cache-key collisions and URI reinterpretation).
    assert.throws(() => assertSafePath('/data/x?uid=admin'), /reserved/);
    assert.throws(() => assertSafePath('/data/x#secret'), /reserved/);
  });
});



// F7: prototype-pollution defense — assertSafeKey/isSafeKey/safeJsonParse + createNode
describe('isSafeKey / assertSafeKey', () => {
  it('rejects __proto__, constructor, prototype', () => {
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(isSafeKey(k), false);
      assert.throws(() => assertSafeKey(k), /Forbidden prototype key/);
    }
  });

  it('accepts ordinary names and $-prefixed names', () => {
    for (const k of ['foo', 'a.b', '$path', '$type', '__bar__', 'protoype']) {
      assert.equal(isSafeKey(k), true);
      assert.doesNotThrow(() => assertSafeKey(k));
    }
  });

  it('createNode rejects __proto__/constructor own properties (raw JSON.parse attack)', () => {
    const polluted = JSON.parse('{"__proto__":{"p":1}}');
    assert.equal(Object.keys(polluted).includes('__proto__'), true);
    assert.throws(() => createNode('/x', 'foo', polluted), /prototype key/);
    const polComp = JSON.parse('{"constructor":{"$type":"x"}}');
    assert.throws(() => createNode('/x', 'foo', {}, polComp), /prototype key/);
  });
});

describe('safeJsonParse', () => {
  it('throws on a __proto__/constructor/prototype key at any depth', () => {
    for (const text of [
      '{"foo": 1, "__proto__": {"p": 2}}',
      '{"a": {"constructor": "x"}}',
      '{"a": [{"b": {"prototype": {}}}]}',
    ]) {
      assert.doesNotThrow(() => JSON.parse(text));
      assert.throws(() => safeJsonParse(text));
    }
    assert.equal(({} as Record<string, unknown>).p, undefined);
  });

  it('preserves nested non-pollution data', () => {
    const obj = safeJsonParse('{"a": {"b": [1, 2, 3]}}');
    assert.deepEqual(obj, { a: { b: [1, 2, 3] } });
  });
});

describe('assertValidType', () => {
  it('accepts treenix conventions', () => {
    for (const t of ['dir', 'mount-point', 't.mount.fs', 'craftistry.block.hero']) {
      assert.doesNotThrow(() => assertValidType(t));
    }
  });

  it('rejects names outside lowercase dot-separated conventions', () => {
    for (const type of ['Example.Type', 'application/json', 'json+ld', 't..dir']) {
      assert.throws(() => assertValidType(type), Error);
    }
  });

  it('rejects non-string, empty, oversize', () => {
    assert.throws(() => assertValidType(undefined), /Invalid \$type/);
    assert.throws(() => assertValidType(null), /Invalid \$type/);
    assert.throws(() => assertValidType(123), /Invalid \$type/);
    assert.throws(() => assertValidType(''), /Invalid \$type/);
    assert.throws(() => assertValidType('a'.repeat(201)), /Invalid \$type/);
  });

  it('rejects control chars, leading non-letter, traversal markers', () => {
    assert.throws(() => assertValidType('foo\0bar'), /Invalid \$type/);
    assert.throws(() => assertValidType('foo\nbar'), /Invalid \$type/);
    assert.throws(() => assertValidType('..'), /Invalid \$type/);
    assert.throws(() => assertValidType('123foo'), /Invalid \$type/);
    assert.throws(() => assertValidType('-foo'), /Invalid \$type/);
  });
});
