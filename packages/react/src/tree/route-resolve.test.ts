import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeData } from '@treenx/core';
import { normalizeUrl, resolveRoute } from './route-resolve';

const node = (path: string, wildcard?: boolean): NodeData => ({
  $path: path,
  $type: 'x',
  ...(wildcard ? { route: { $type: 't.route', wildcard: true } } : {}),
} as NodeData);

describe('normalizeUrl', () => {
  it('trims leading + trailing slashes', () => {
    assert.equal(normalizeUrl('/foo/bar/'), 'foo/bar');
    assert.equal(normalizeUrl('foo/bar'), 'foo/bar');
    assert.equal(normalizeUrl('/'), '');
    assert.equal(normalizeUrl(''), '');
    assert.equal(normalizeUrl(null), '');
    assert.equal(normalizeUrl(undefined), '');
  });
});

describe('resolveRoute', () => {
  const routes = [
    node('/sys/routes/_index'),                  // root
    node('/sys/routes/about'),                   // exact "about"
    node('/sys/routes/t', true),                 // wildcard "t/*"
    node('/sys/routes/v', true),                 // wildcard "v/*"
    node('/sys/routes/blog/post', true),         // wildcard "blog/post/*"
  ];

  it('exact match wins over any wildcard', () => {
    const r = resolveRoute('/about', routes);
    assert.ok(r);
    assert.equal(r.node.$path, '/sys/routes/about');
    assert.equal(r.rest, '');
  });

  it('wildcard catches descendants under its prefix', () => {
    const r = resolveRoute('/t/users/alice', routes);
    assert.ok(r);
    assert.equal(r.node.$path, '/sys/routes/t');
    assert.equal(r.rest, 'users/alice');
  });

  it('wildcard with no descendant returns empty rest', () => {
    const r = resolveRoute('/t', routes);
    assert.ok(r);
    assert.equal(r.node.$path, '/sys/routes/t');
    assert.equal(r.rest, '');
  });

  it('longest-prefix wildcard wins', () => {
    const r = resolveRoute('/blog/post/hello', routes);
    assert.ok(r);
    assert.equal(r.node.$path, '/sys/routes/blog/post');
    assert.equal(r.rest, 'hello');
  });

  it('_index matches the root URL', () => {
    const r1 = resolveRoute('/', routes);
    const r2 = resolveRoute('', routes);
    assert.ok(r1);
    assert.ok(r2);
    assert.equal(r1.node.$path, '/sys/routes/_index');
    assert.equal(r2.node.$path, '/sys/routes/_index');
  });

  it('returns null when no match exists', () => {
    const r = resolveRoute('/unknown', routes);
    assert.equal(r, null);
  });

  it('non-wildcard sibling does not match descendants', () => {
    // "about" is exact-only; "/about/x" should NOT match it
    const r = resolveRoute('/about/x', routes);
    assert.equal(r, null);
  });

  it('root wildcard catches everything when present', () => {
    const withRootWildcard = [
      node('/sys/routes/about'),
      node('/sys/routes/_index', true),  // wildcard at root
    ];
    const r = resolveRoute('/anything/here', withRootWildcard);
    assert.ok(r);
    assert.equal(r.node.$path, '/sys/routes/_index');
    assert.equal(r.rest, 'anything/here');
  });

  it('normalises trailing slashes before matching', () => {
    const r = resolveRoute('/about/', routes);
    assert.ok(r);
    assert.equal(r.node.$path, '/sys/routes/about');
  });
});
