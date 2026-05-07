import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHref } from './use-route-shell';
import { Route } from './route';

describe('buildHref — editor route (no prefix, preserveQuery: { root: "/" })', () => {
  const opts = { root: '/' };

  it('plain path → /t/<rel>', () => {
    assert.equal(buildHref('/foo', undefined, 't', '', opts), '/t/foo');
  });

  it('preserves ?root=/x', () => {
    assert.equal(buildHref('/foo', undefined, 't', 'root=%2Fx', opts), '/t/foo?root=%2Fx');
  });

  it('omits default ?root=/', () => {
    assert.equal(buildHref('/foo', undefined, 't', 'root=%2F', opts), '/t/foo');
  });

  it('root path → /t', () => {
    assert.equal(buildHref('/', undefined, 't', '', opts), '/t');
  });
});

describe('buildHref — view route (no prefix, preserveQuery: { ctx: "react" })', () => {
  const opts = { ctx: 'react' };

  it('preserves ?ctx=card', () => {
    assert.equal(buildHref('/x', undefined, 'v', 'ctx=card', opts), '/v/x?ctx=card');
  });

  it('omits default ?ctx=react', () => {
    assert.equal(buildHref('/x', undefined, 'v', 'ctx=react', opts), '/v/x');
  });
});

describe('buildHref — docs route (prefix=/docs, index=index)', () => {
  const route: Route = { prefix: '/docs', index: 'index' };

  it('prefix child → /d/<rel>', () => {
    assert.equal(buildHref('/docs/foo', route, 'd', ''), '/d/foo');
  });

  it('exact prefix → /d', () => {
    assert.equal(buildHref('/docs', route, 'd', ''), '/d');
  });

  it('index canonicalised to /d', () => {
    assert.equal(buildHref('/docs/index', route, 'd', ''), '/d');
  });

  it('outside prefix → null (blocked)', () => {
    assert.equal(buildHref('/sys/types/foo', route, 'd', ''), null);
  });

  it('partial prefix-match (false positive) → null', () => {
    // /docsy is NOT under /docs even though string starts with same chars
    assert.equal(buildHref('/docsy', route, 'd', ''), null);
  });

  it('nested under prefix → /d/<deep>', () => {
    assert.equal(buildHref('/docs/a/b/c', route, 'd', ''), '/d/a/b/c');
  });
});

describe('buildHref — root route (no prefix, no preserveQuery)', () => {
  it('descendant path → /<key>/<rel>', () => {
    assert.equal(buildHref('/foo/bar', undefined, 'home', '', undefined), '/home/foo/bar');
  });

  it('empty key on _index route → /', () => {
    assert.equal(buildHref('/', undefined, '', '', undefined), '/');
  });

  it('empty key + descendant → /<rel> (no leading double slash)', () => {
    // Regression: empty key with non-empty rel must not produce "//foo".
    assert.equal(buildHref('/foo', undefined, '', '', undefined), '/foo');
  });
});

describe('buildHref — prefix normalization', () => {
  it('trailing slash on prefix is stripped', () => {
    const route: Route = { prefix: '/docs/', index: 'index' };
    assert.equal(buildHref('/docs/foo', route, 'd', ''), '/d/foo');
  });

  it('prefix "/" is treated as no prefix', () => {
    const route: Route = { prefix: '/' };
    assert.equal(buildHref('/foo', route, 'k', ''), '/k/foo');
  });

  it('missing leading slash on prefix is added', () => {
    const route: Route = { prefix: 'docs', index: 'index' };
    assert.equal(buildHref('/docs/foo', route, 'd', ''), '/d/foo');
  });
});
