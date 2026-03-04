import { basename, dirname, isChildPath, join } from '#core/path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  render,
  resolve,
  unregister,
} from './index';

export function clearRegistry(): void {
  mapRegistry((t, c) => unregister(t, c));
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
    assert.ok(!isComponent(node['missing']));
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

