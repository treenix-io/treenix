import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildNodeLinkHref, getNodeLinkPath } from './node-link-click';

describe('getNodeLinkPath', () => {
  it('returns the closest node-link path', () => {
    const target = {
      closest: (selector: string) =>
        selector === 'a[data-node-path]'
          ? { getAttribute: (name: string) => (name === 'data-node-path' ? '/docs/intro' : null) }
          : null,
    };

    assert.equal(getNodeLinkPath(target), '/docs/intro');
  });

  it('returns null when target is not inside a node link', () => {
    const target = { closest: () => null };
    assert.equal(getNodeLinkPath(target), null);
  });

  it('returns null for non-element targets', () => {
    assert.equal(getNodeLinkPath(null), null);
    assert.equal(getNodeLinkPath({}), null);
    assert.equal(getNodeLinkPath('text' as unknown as EventTarget), null);
  });
});

describe('buildNodeLinkHref', () => {
  it('keeps editor root query when navigating inside /t', () => {
    assert.equal(
      buildNodeLinkHref('/docs/target', '/t/docs/source', '?root=%2Fdocs'),
      '/t/docs/target?root=%2Fdocs',
    );
  });

  it('uses /v prefix in direct view mode', () => {
    assert.equal(buildNodeLinkHref('/docs/target', '/v/docs/source'), '/v/docs/target');
  });

  it('navigates directly in routed mode', () => {
    assert.equal(buildNodeLinkHref('/docs/target', '/docs/source'), '/docs/target');
  });
});
