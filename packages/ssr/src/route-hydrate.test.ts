// Regression: SSR route hydration must deep-scan /sys/routes.
//
// Bug (core-cnr.2 / C3): rebuildRoutes used `depth: -1` intending "all
// descendants", but at the time no store treated -1 as deep (memory → [],
// mongo → a `{1,-1}` regex matching nothing), so RouteIndex stayed empty and
// every HTML request silently fell back to the client-only SPA. `-1` is now
// the deep sentinel honored by every store.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTree } from '@treenx/core/tree';
import { RouteIndex, fetchRouteNodes } from './route-index.ts';

function seedRoutes() {
  const tree = createMemoryTree();
  // Nested route: depth-2 under /sys/routes. A shallow fetch (or the -1 bug)
  // misses it; only a deep scan surfaces it.
  return tree.set({ $path: '/sys/routes/v/admin', $type: 't.admin.shell', route: { $type: 't.route', wildcard: true } })
    .then(() => tree.set({ $path: '/sys/routes/about', $type: 'page' }))
    .then(() => tree);
}

describe('SSR route hydration (deep scan)', () => {
  it('fetchRouteNodes returns deeply-nested route nodes', async () => {
    const tree = await seedRoutes();
    const nodes = await fetchRouteNodes(tree);
    const paths = nodes.map(n => n.$path).sort();
    // The depth-2 node /sys/routes/v/admin proves the scan is deep, not shallow.
    // (/sys/routes/v is an intermediate path with no data, so it's absent.)
    assert.deepEqual(paths, ['/sys/routes/about', '/sys/routes/v/admin']);
  });

  it('hydrating a RouteIndex from a nested tree yields a non-empty index', async () => {
    const tree = await seedRoutes();
    const idx = new RouteIndex();
    idx.hydrate(await fetchRouteNodes(tree));
    assert.ok(idx.size() > 0, 'RouteIndex must not be empty after hydrate');
    // The nested wildcard route must actually resolve a deep URL.
    const r = idx.resolve('/v/admin/users/42');
    assert.equal(r!.node.$path, '/sys/routes/v/admin');
    assert.equal(r!.rest, 'users/42');
  });
});
