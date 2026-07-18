// PathNotifier scope parity (ns6p.4 invariant 20): the three scopes must
// reproduce the contracts of the registries the notifier replaced —
// CDC prefix (self + every descendant), L3 children (direct only), exact.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPathNotifier } from './notifier';

type Ev = { path: string };

describe('PathNotifier — scope parity (invariant 20)', () => {
  it('exact: fires on the registered path only', () => {
    const n = createPathNotifier<Ev>();
    const got: string[] = [];
    n.register('/a/b', 'exact', (e) => got.push(e.path));

    n.notify('/a/b', { path: '/a/b' });
    n.notify('/a', { path: '/a' });
    n.notify('/a/b/c', { path: '/a/b/c' });
    n.notify('/a/bx', { path: '/a/bx' });

    assert.deepEqual(got, ['/a/b']);
  });

  it('children: direct children only — never the path itself, never grandchildren, never sibling-prefix', () => {
    const n = createPathNotifier<Ev>();
    const got: string[] = [];
    n.register('/dir', 'children', (e) => got.push(e.path));

    n.notify('/dir', { path: '/dir' });           // self — excluded (L3 contract)
    n.notify('/dir/a', { path: '/dir/a' });       // direct — fires
    n.notify('/dir/a/b', { path: '/dir/a/b' });   // grandchild — excluded
    n.notify('/dirx/a', { path: '/dirx/a' });     // sibling prefix — excluded

    assert.deepEqual(got, ['/dir/a']);
  });

  it('children at root: top-level paths only', () => {
    const n = createPathNotifier<Ev>();
    const got: string[] = [];
    n.register('/', 'children', (e) => got.push(e.path));

    n.notify('/', { path: '/' });
    n.notify('/top', { path: '/top' });
    n.notify('/top/nested', { path: '/top/nested' });

    assert.deepEqual(got, ['/top']);
  });

  it('subtree: self + every descendant (CDC prefix contract), not siblings', () => {
    const n = createPathNotifier<Ev>();
    const got: string[] = [];
    n.register('/bot', 'subtree', (e) => got.push(e.path));

    n.notify('/bot', { path: '/bot' });                             // self — fires
    n.notify('/bot/commands/start', { path: '/bot/commands/start' }); // deep descendant — fires
    n.notify('/botx', { path: '/botx' });                           // sibling prefix — excluded
    n.notify('/users/1', { path: '/users/1' });                     // unrelated — excluded

    assert.deepEqual(got, ['/bot', '/bot/commands/start']);
  });

  it('subtree at root matches everything (the L3 all scope)', () => {
    const n = createPathNotifier<Ev>();
    const got: string[] = [];
    n.register('/', 'subtree', (e) => got.push(e.path));

    n.notify('/', { path: '/' });
    n.notify('/a', { path: '/a' });
    n.notify('/a/b/c', { path: '/a/b/c' });

    assert.deepEqual(got, ['/', '/a', '/a/b/c']);
  });

  it('one event fans out across scopes; unregister stops exactly its consumer', () => {
    const n = createPathNotifier<Ev>();
    const got: string[] = [];
    const offExact = n.register('/d/x', 'exact', () => got.push('exact'));
    n.register('/d', 'children', () => got.push('children'));
    n.register('/', 'subtree', () => got.push('subtree'));

    n.notify('/d/x', { path: '/d/x' });
    assert.deepEqual(got.sort(), ['children', 'exact', 'subtree']);

    got.length = 0;
    offExact();
    offExact(); // idempotent
    n.notify('/d/x', { path: '/d/x' });
    assert.deepEqual(got.sort(), ['children', 'subtree']);
  });

  it('same consumer on the same path registers once per scope (Set semantics)', () => {
    const n = createPathNotifier<Ev>();
    let count = 0;
    const fn = () => { count++; };
    n.register('/p', 'exact', fn);
    n.register('/p', 'exact', fn);

    n.notify('/p', { path: '/p' });
    assert.equal(count, 1);
  });
});
