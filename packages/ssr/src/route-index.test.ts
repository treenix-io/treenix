import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeData } from '@treenx/core';
import { RouteIndex } from './route-index';

const route = (path: string, type: string, wildcard = false): NodeData => ({
  $path: path,
  $type: type,
  ...(wildcard ? { route: { $type: 't.route', wildcard: true } } : {}),
});

describe('RouteIndex', () => {
  it('hydrates from a flat list and resolves exact matches', () => {
    const idx = new RouteIndex();
    idx.hydrate([route('/sys/routes/about', 'page')]);
    const r = idx.resolve('/about');
    assert.ok(r);
    assert.equal(r!.node.$path, '/sys/routes/about');
    assert.equal(r!.rest, '');
  });

  it('falls through to wildcard when no exact match', () => {
    const idx = new RouteIndex();
    idx.hydrate([
      route('/sys/routes/v', 't.view.shell', true),
      route('/sys/routes/about', 'page'),
    ]);
    const r = idx.resolve('/v/foo/bar');
    assert.equal(r!.node.$path, '/sys/routes/v');
    assert.equal(r!.rest, 'foo/bar');
  });

  it('exact match wins over wildcard at same prefix', () => {
    const idx = new RouteIndex();
    idx.hydrate([
      route('/sys/routes/v', 't.view.shell', true),
      route('/sys/routes/v', 'exact-override'),
    ]);
    // Last ingest wins for same path; here exact non-wildcard replaces.
    const r = idx.resolve('/v');
    assert.equal(r!.node.$type, 'exact-override');
    assert.equal(r!.rest, '');
  });

  it('longest prefix wins among wildcards', () => {
    const idx = new RouteIndex();
    idx.hydrate([
      route('/sys/routes/v', 't.view.shell', true),
      route('/sys/routes/v/admin', 't.admin.shell', true),
    ]);
    const r = idx.resolve('/v/admin/users/42');
    assert.equal(r!.node.$path, '/sys/routes/v/admin');
    assert.equal(r!.rest, 'users/42');
  });

  it('_index matches root URL', () => {
    const idx = new RouteIndex();
    idx.hydrate([route('/sys/routes/_index', 'home')]);
    const r = idx.resolve('/');
    assert.equal(r!.node.$type, 'home');
  });

  it('returns null for unmatched URL with no wildcard', () => {
    const idx = new RouteIndex();
    idx.hydrate([route('/sys/routes/about', 'page')]);
    assert.equal(idx.resolve('/missing'), null);
  });

  it('ignores nodes outside /sys/routes/', () => {
    const idx = new RouteIndex();
    idx.ingest(route('/demo/landing', 'page'));
    assert.equal(idx.size(), 0);
  });

  it('remove() evicts a route', () => {
    const idx = new RouteIndex();
    idx.hydrate([route('/sys/routes/about', 'page')]);
    idx.remove('/sys/routes/about');
    assert.equal(idx.resolve('/about'), null);
  });

  it('replacing a route via ingest swaps the node', () => {
    const idx = new RouteIndex();
    idx.ingest(route('/sys/routes/x', 'old'));
    idx.ingest(route('/sys/routes/x', 'new'));
    assert.equal(idx.size(), 1);
    assert.equal(idx.resolve('/x')!.node.$type, 'new');
  });

  it('toggling wildcard via re-ingest changes resolution behavior', () => {
    const idx = new RouteIndex();
    idx.ingest(route('/sys/routes/v', 't.view.shell'));
    assert.equal(idx.resolve('/v/x'), null);
    idx.ingest(route('/sys/routes/v', 't.view.shell', true));
    assert.equal(idx.resolve('/v/x')!.rest, 'x');
  });
});
