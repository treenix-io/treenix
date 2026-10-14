import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseURI } from './uri';

describe('parseURI', () => {
  it('#name = key (component/field access)', () => {
    const r = parseURI('/sys/types/cafe/contact#schema');
    assert.deepEqual(r, { path: '/sys/types/cafe/contact', key: 'schema' });
  });

  it('#key.field = sub-field within component', () => {
    const r = parseURI('/users/me#profile.email');
    assert.deepEqual(r, { path: '/users/me', key: 'profile', field: 'email' });
  });

  it('#action() = node-level action (no key)', () => {
    const r = parseURI('/cafe/contact#submit()');
    assert.deepEqual(r, { path: '/cafe/contact', action: 'submit' });
  });

  it('#key.action() = action on named component', () => {
    const r = parseURI('/cafe/contact#contact.submit()');
    assert.deepEqual(r, { path: '/cafe/contact', key: 'contact', action: 'submit' });
  });

  it('action with query params (standard order: ?query#fragment)', () => {
    const r = parseURI('/users?role=admin&limit=10#find()');
    assert.deepEqual(r, {
      path: '/users',
      action: 'find',
      data: { role: 'admin', limit: 10 },
    });
  });

  it('nested dot-notation params', () => {
    const r = parseURI('/col?age.$gt=10&age.$lt=50#find()');
    assert.equal(r.path, '/col');
    assert.equal(r.action, 'find');
    const age = r.data!.age as Record<string, unknown>;
    assert.equal(age.$gt, 10);
    assert.equal(age.$lt, 50);
  });

  it('boolean and null coercion in params', () => {
    const r = parseURI('/x?a=true&b=false&c=null#do()');
    assert.deepEqual(r, {
      path: '/x',
      action: 'do',
      data: { a: true, b: false, c: null },
    });
  });

  it('url-encoded values', () => {
    const r = parseURI('/x?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82#find()');
    assert.deepEqual(r, {
      path: '/x',
      action: 'find',
      data: { q: 'привет' },
    });
  });

  it('path-only URI returns just path', () => {
    const r = parseURI('/some/path');
    assert.deepEqual(r, { path: '/some/path' });
  });

  it('empty fragment returns just path', () => {
    const r = parseURI('/some/path#');
    assert.deepEqual(r, { path: '/some/path' });
  });

  it('throws on empty name after key', () => {
    assert.throws(() => parseURI('/x#key.'), /Empty name/);
  });

  it('empty parens = action, not field named "()"', () => {
    const r = parseURI('/x#do()');
    assert.equal(r.action, 'do');
    assert.equal(r.field, undefined);
  });

  it('no query = no data field', () => {
    const r = parseURI('/x#submit()');
    assert.equal(r.data, undefined);
  });

  it('#key does not set field or action', () => {
    const r = parseURI('/x#view');
    assert.equal(r.key, 'view');
    assert.equal(r.field, undefined);
    assert.equal(r.action, undefined);
  });

  it('#key.field does not set action', () => {
    const r = parseURI('/x#profile.name');
    assert.equal(r.key, 'profile');
    assert.equal(r.field, 'name');
    assert.equal(r.action, undefined);
  });

  it('#action() does not set key', () => {
    const r = parseURI('/x#run()');
    assert.equal(r.action, 'run');
    assert.equal(r.key, undefined);
  });

  it('#key.action() sets both key and action', () => {
    const r = parseURI('/x#comp.run()');
    assert.equal(r.key, 'comp');
    assert.equal(r.action, 'run');
    assert.equal(r.field, undefined);
  });
});

describe('prototype pollution prevention', () => {
  it('__proto__ key is silently ignored', () => {
    const r = parseURI('/x?__proto__.isAdmin=true#find()');
    assert.equal(r.data?.isAdmin, undefined);
    assert.equal(({} as any).isAdmin, undefined, 'Object.prototype must not be polluted');
  });

  it('constructor key is silently ignored', () => {
    const r = parseURI('/x?constructor.polluted=true#find()');
    assert.equal(
      r.data!.hasOwnProperty('constructor'),
      false,
      'constructor not set as own property',
    );
    assert.equal(({} as any).polluted, undefined, 'Object constructor not polluted');
  });

  it('prototype key is silently ignored', () => {
    const r = parseURI('/x?prototype.polluted=true#find()');
    assert.equal(r.data?.prototype, undefined);
  });

  it('nested __proto__ in middle of path is ignored', () => {
    const r = parseURI('/x?a.__proto__.b=1#find()');
    // `a` intermediate is created, but __proto__ traversal is blocked — `b` never set
    assert.ok(r.data?.a !== undefined, 'intermediate `a` is created');
    assert.equal(({} as any).b, undefined, 'Object.prototype must not be polluted');
  });

  it('forbidden key as final segment is ignored', () => {
    const r = parseURI('/x?a.__proto__=1#find()');
    // `a` intermediate is created, but __proto__ assignment is blocked
    assert.ok(r.data?.a !== undefined, 'intermediate `a` is created');
    assert.equal((r.data!.a as any).__proto__, undefined, '__proto__ not assigned');
  });

  it('normal dot-notation still works after hardening', () => {
    const r = parseURI('/x?age.$gt=10&name=test#find()');
    assert.equal(r.data!.name, 'test');
    assert.equal((r.data!.age as any).$gt, 10);
  });
});
