import { assertSafePath, basename, dirname, isChildPath, join } from '#core/path';
import { registerBuiltins } from '#mods/treenix/builtins';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  createNode,
  getComponent,
  getComponents,
  isComponent,
  isRef,
  mapRegistry,
  ref,
  register,
  removeComponent,
  onResolveMiss,
  render,
  resolve,
  unregister,
} from './index';

const testTypes = ['test.doc', 'test.item', 'test.session', 'test.task'];

export function registerTestTypes() {
  for (const t of testTypes)
    register(t, 'schema', () => ({ $id: t, type: 'object' as const, title: t, properties: {} }));
}

registerTestTypes();

export function clearRegistry(): void {
  mapRegistry((t, c) => unregister(t, c));
  registerBuiltins();
  registerTestTypes();
}

/** Save current registry state — pairs with restoreRegistrySnapshot */
export function saveRegistrySnapshot(): Map<string, unknown> {
  const snap = new Map<string, unknown>();
  mapRegistry((t, c) => { snap.set(`${t}@${c}`, resolve(t, c, false)); });
  return snap;
}

/** Restore a saved snapshot — clears registry then re-registers all entries */
export function restoreRegistrySnapshot(snap: Map<string, unknown>): void {
  mapRegistry((t, c) => unregister(t, c));
  for (const [key, handler] of snap) {
    const i = key.lastIndexOf('@');
    register(key.slice(0, i), key.slice(i + 1), handler as any);
  }
}

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
    assert.equal(node.info.$type, 'task');
    assert.equal(node.budget.amount, 100);
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
    assert.deepEqual(moneys.map(([name]) => name).sort(), ['budget', 'estimate']);
  });

  it('isComponent type guard', () => {
    assert.ok(isComponent(node['budget']));
    assert.ok(!isComponent((node as any)['missing']));
    assert.ok(!isComponent('string'));
    assert.ok(!isComponent(null));
  });

  it('set and remove', () => {
    const n = createNode('/x', 'x');
    (n as any).tag = { $type: 'tag', value: 'urgent' };
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

describe('Context', () => {
  it('register and resolve exact', () => {
    clearRegistry();
    register('task', 'test', (data) => `<Task ${(data as any).status} />`);
    const handler = resolve('task', 'test');
    assert.ok(handler);
    assert.equal(handler({ $type: 'task', status: 'open' }), '<Task open />');
  });

  it('fallback from specific to general', () => {
    clearRegistry();
    register('task', 'test', () => 'general');
    register('task', 'test:compact', () => 'compact');

    assert.equal(resolve('task', 'test:compact')?.({} as any), 'compact');
    assert.equal(resolve('task', 'test:compact:mini')?.({} as any), 'compact');
    assert.equal(resolve('task', 'test')?.({} as any), 'general');
  });

  it('default wins over stripped context', () => {
    clearRegistry();
    register('default', 'test:compact:mini', () => 'default:mini');
    register('default', 'test', () => 'default');
    register('task', 'test', () => 'general');
    register('task', 'test:compact', () => 'compact');

    assert.equal(resolve('task', 'test:compact')?.({} as any), 'compact');
    assert.equal(resolve('task', 'test:compact:mini')?.({} as any), 'default:mini');
    assert.equal(resolve('task', 'test')?.({} as any), 'general');
    assert.equal(resolve('unknown', 'test:compact:mini')?.({} as any), 'default:mini');
    assert.equal(resolve('unknown', 'test:compact')?.({} as any), 'default');
  });

  it('fallback to default', () => {
    clearRegistry();
    register('default', 'test', () => 'default');
    assert.equal(resolve('task', 'test')?.({} as any), 'default');
    assert.equal(resolve('task', 'test:compact')?.({} as any), 'default');
  });

  it('strip still works without default', () => {
    clearRegistry();
    register('task', 'react', () => 'react');
    assert.equal(resolve('task', 'react:edit:inline')?.({} as any), 'react');
    assert.equal(resolve('task', 'react:edit')?.({} as any), 'react');
  });

  it('returns null when nothing found', () => {
    clearRegistry();
    assert.equal(resolve('unknown', 'test'), null);
  });

  it('render throws on missing handler', () => {
    clearRegistry();
    assert.throws(() => render({ $type: 'nope' }, 'react'));
  });
});

describe('Context + missResolver fallback', () => {
  it('resolve returns default handler when miss resolver exists but no exact match', () => {
    clearRegistry();
    const missed: string[] = [];
    onResolveMiss('test-miss', (type: string) => missed.push(type));
    register('default', 'test-miss', () => 'fallback');

    const handler = resolve('unknown.type', 'test-miss');
    assert.equal(handler?.({} as any), 'fallback', 'should return default handler');
    assert.deepEqual(missed, ['unknown.type'], 'should have triggered miss resolver');

    unregister('default', 'test-miss');
    onResolveMiss('test-miss', () => {});
  });

  it('resolve prefers exact match over default even with miss resolver', () => {
    clearRegistry();
    onResolveMiss('test-miss2', () => {});
    register('default', 'test-miss2', () => 'fallback');
    register('exact.type', 'test-miss2', () => 'exact');

    const handler = resolve('exact.type', 'test-miss2');
    assert.equal(handler?.({} as any), 'exact', 'exact match wins');

    unregister('default', 'test-miss2');
    unregister('exact.type', 'test-miss2');
    onResolveMiss('test-miss2', () => {});
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
});

describe('Lazy resolver semantics (sync miss)', () => {
  afterEach(() => {
    // onResolveMiss is singleton-per-context; reset to noop so this describe block
    // does not leak a 'schema' resolver into other test suites.
    onResolveMiss('schema', () => {});
  });

  it('returns handler registered synchronously by miss resolver in same resolve() call', () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'lazy.synctest.A';
      let parseCount = 0;

      onResolveMiss('schema', (type) => {
        if (type !== TYPE) return;
        parseCount++;
        register(type, 'schema', () => ({ $id: type, type: 'object' as const, title: 'A', properties: {} }));
      });

      const handler = resolve(TYPE, 'schema');
      assert.ok(handler, 'sync miss resolver registered handler — resolve must return it on first call, not null');
      assert.equal(parseCount, 1, 'resolver must run exactly once');
      const schema = (handler as any)();
      assert.equal(schema.$id, TYPE);
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });

  it('async miss resolver still uses bump+re-render path (returns null first call, handler after)', async () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'lazy.async.B';
      let resolved: (() => void) | null = null;
      const work = new Promise<void>((res) => { resolved = res; });

      onResolveMiss('schema', (type) => {
        if (type !== TYPE) return;
        // Simulate async fetch — register on next tick
        Promise.resolve().then(() => {
          register(type, 'schema', () => ({ $id: type, type: 'object' as const, title: 'B', properties: {} }));
          resolved!();
        });
      });

      const first = resolve(TYPE, 'schema');
      assert.equal(first, null, 'async path: first resolve returns null while resolver runs in background');

      await work;
      const second = resolve(TYPE, 'schema');
      assert.ok(second, 'async path: second resolve returns the handler registered in background');
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });

  it('miss resolver that does not register: resolve falls through to default/null', () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'lazy.noop.C';
      let invoked = 0;

      onResolveMiss('schema', (type) => {
        if (type !== TYPE) return;
        invoked++;
        // Deliberately do NOT register — simulate "not my prefix" early-return
      });

      const handler = resolve(TYPE, 'schema');
      assert.equal(invoked, 1, 'resolver was invoked');
      assert.equal(handler, null, 'no registration → resolve returns null');
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });
});

