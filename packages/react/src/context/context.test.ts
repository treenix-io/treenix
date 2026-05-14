import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { $key, $node, stampNode } from '#symbols';
import { viewCtx } from '#context';
import type { NodeData } from '@treenx/core';

function makeNode(path: string, type: string, components?: Record<string, { $type: string }>): NodeData {
  const node = { $path: path, $type: type, ...components } as NodeData;
  stampNode(node);
  return node;
}

describe('stampNode', () => {
  it('stamps $node and $key on the node itself', () => {
    const node = makeNode('/org/acme', 'org');
    assert.equal((node as any)[$node], node);
    assert.equal((node as any)[$key], '');
  });

  it('stamps $node and $key on named components', () => {
    const node = makeNode('/org/acme', 'org', {
      settings: { $type: 'org.settings' },
    });
    const settings = (node as any).settings;
    assert.equal(settings[$node], node);
    assert.equal(settings[$key], 'settings');
  });

  it('does not stamp $-prefixed fields', () => {
    const node = makeNode('/org/acme', 'org');
    assert.equal((node as any).$path[$key], undefined);
  });

  it('does not stamp non-component values', () => {
    const node = { $path: '/x', $type: 'x', label: 'hello' } as NodeData;
    stampNode(node);
    // plain string — no symbols
    assert.equal((node as any).label[$key], undefined);
  });

  // Regression: editor's auto-save merges into the cached node via shallow spread,
  // sharing top-level component refs. The prior cache.put + devFreeze locked their
  // $key/$node symbols non-configurable; re-stamping the merged node tried to
  // Object.defineProperty on a frozen prop and threw "Cannot redefine property".
  // Triggered by /docs/index.md (doc.page with doc.frontmatter) — bug since a85fd7e.
  it('skips re-stamping a frozen shared component (auto-save merge after devFreeze)', () => {
    const node = makeNode('/docs/index.md', 'doc.page', {
      'doc.frontmatter': { $type: 'doc.frontmatter' },
    });
    const frontmatter = (node as any)['doc.frontmatter'];
    Object.freeze(frontmatter);
    Object.freeze(node);

    const merged = { ...node, title: 'New' } as NodeData;
    stampNode(merged);

    assert.equal((merged as any)[$node], merged);
    assert.equal((merged as any)[$key], '');
    assert.equal((merged as any)['doc.frontmatter'], frontmatter);
    assert.equal(frontmatter[$key], 'doc.frontmatter');
    assert.equal(frontmatter[$node].$path, '/docs/index.md');
  });
});

describe('viewCtx', () => {
  it('returns null for unstamped value', () => {
    assert.equal(viewCtx({ $type: 'test' }), null);
  });

  it('returns node path for node-level component', () => {
    const node = makeNode('/org/acme', 'org');
    const ctx = viewCtx(node);
    assert.ok(ctx);
    assert.equal(ctx.path, '/org/acme');
    assert.equal(ctx.node, node);
  });

  it('returns path#key for named component', () => {
    const node = makeNode('/org/acme', 'org', {
      settings: { $type: 'org.settings' },
    });
    const ctx = viewCtx((node as any).settings);
    assert.ok(ctx);
    assert.equal(ctx.path, '/org/acme#settings');
    assert.equal(ctx.node, node);
  });

  it('execute uses node path for node-level value', () => {
    const node = makeNode('/tasks/1', 'task');
    const ctx = viewCtx(node)!;
    assert.ok(ctx.execute);
    assert.equal(ctx.path, '/tasks/1');
  });

  it('execute uses path#key for named component', () => {
    const node = makeNode('/tasks/1', 'task', {
      checklist: { $type: 'simple.checklist' },
    });
    const ctx = viewCtx((node as any).checklist)!;
    assert.equal(ctx.path, '/tasks/1#checklist');
  });

  it('returns null for value without $node symbol', () => {
    const plain = { $type: 'simple.checklist', items: [] };
    assert.equal(viewCtx(plain), null);
  });
});
