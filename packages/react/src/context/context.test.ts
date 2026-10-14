import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode, useState } from 'react';
import { $key, $node, stampNode } from '#symbols';
import {
  Render,
  RenderContext,
  RenderField,
  type RenderProps,
  useTreeContext,
  viewCtx,
} from '#context';
import { type NodeData } from '@treenx/core';
import {
  createClientRegistry,
  declareClientModule,
  declareView,
  type ClientRegistry,
} from '#context/client-registry';
import { ClientRegistryContext } from './client-registry-context';

function makeNode(
  path: string,
  type: string,
  components?: Record<string, { $type: string }>,
): NodeData {
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

describe('Render — sub-context loader (C38)', () => {
  afterEach(() => cleanup());

  it('fires the base-context miss resolver when rendering at a sub-context', () => {
    const T = 'uix.lazy.test';
    let fired = false;
    const registry = createClientRegistry([
      {
        id: 'lazy-view',
        open: [],
        resolveMissing(type, context) {
          if (type !== T || context !== 'react') return undefined;
          fired = true;
          return { type, context, handler: () => createElement('span', null, 'loaded') };
        },
      },
    ]);

    // Rendering at a sub-context (react:zzztest) must reach the base 'react' loader.
    render(
      createElement(ClientRegistryContext.Provider, {
        value: registry,
        children: createElement(RenderContext, {
          name: 'react:zzztest',
          children: createElement(Render, { value: { $type: T } }),
        }),
      }),
    );

    assert.ok(fired, 'sub-context render must trigger the base "react" loader');
  });
});

describe('RenderContext selectors', () => {
  afterEach(() => cleanup());

  const scope = (name: string, children: ReactNode) =>
    createElement(RenderContext, { name, children });
  const provide = (registry: ClientRegistry, children: ReactNode) =>
    createElement(ClientRegistryContext.Provider, { value: registry, children });
  const showContext = () => createElement('output', null, useTreeContext());

  it('inherits modifiers, replaces the base suffix, and isolates sibling scopes', () => {
    const result = render(
      scope(
        'react:table !edit +compact',
        createElement(
          'div',
          null,
          scope(':cell', createElement(showContext)),
          scope(':table:cell', createElement(showContext)),
          scope('site:card', createElement(showContext)),
          scope('', createElement(showContext)),
        ),
      ),
    );
    assert.deepEqual(
      result.getAllByRole('status').map((el) => el.textContent),
      [
        'react:cell !edit +compact',
        'react:table:cell !edit +compact',
        'site:card !edit +compact',
        'react:table !edit +compact',
      ],
    );
  });

  it('applies the last modifier declaration and moves additions to the end', () => {
    const result = render(
      scope(
        'react !edit +compact',
        createElement(
          'div',
          null,
          scope('+edit', createElement(showContext)),
          scope('-edit +acme.review !edit', createElement(showContext)),
          scope('!compact -edit +edit -edit', createElement(showContext)),
          createElement(showContext),
        ),
      ),
    );
    assert.deepEqual(
      result.getAllByRole('status').map((el) => el.textContent),
      [
        'react +compact +edit',
        'react +compact +acme.review !edit',
        'react !compact',
        'react !edit +compact',
      ],
    );
  });

  it('selects editable cells, a readonly row, and a descendant that enables editing again', () => {
    const value = { $type: 'test.cell' };
    const registry = createClientRegistry([
      declareClientModule('cells', [
        declareView(value.$type, 'react:cell +compact', () =>
          createElement('span', null, 'readonly'),
        ),
        declareView(value.$type, 'react:cell +compact +edit', () =>
          createElement('span', null, 'editable'),
        ),
      ]),
    ]);
    const cell = () => scope(':cell', createElement(Render, { value }));
    const result = render(
      provide(
        registry,
        scope(
          'react:table +compact !edit',
          createElement(
            'div',
            null,
            cell(),
            scope('-edit', createElement('div', null, cell(), scope('+edit', cell()))),
            cell(),
          ),
        ),
      ),
    );
    assert.equal(result.container.textContent, 'editablereadonlyeditableeditable');
  });

  it('passes the full effective context through fallback to handlers and their children', () => {
    const registry = createClientRegistry([
      declareClientModule('fallback', [
        declareView('test.parent', 'react +edit', () =>
          createElement(
            'div',
            null,
            createElement(showContext),
            scope(':child', createElement(Render, { value: { $type: 'test.child' } })),
          ),
        ),
        declareView('test.child', 'react:child +edit +acme.review', showContext),
      ]),
    ]);
    const result = render(
      provide(
        registry,
        scope(
          'react:table:cell !edit +acme.review',
          createElement(Render, { value: { $type: 'test.parent' } }),
        ),
      ),
    );
    assert.deepEqual(
      result.getAllByRole('status').map((el) => el.textContent),
      ['react:table:cell !edit +acme.review', 'react:child !edit +acme.review'],
    );
  });

  it('keeps handler state when contexts change and selects the new preset', () => {
    const Counter = ({ label }: RenderProps & { label?: unknown }) => {
      const [count, setCount] = useState(0);
      return createElement('button', { onClick: () => setCount(count + 1) }, `${label}:${count}`);
    };
    const registry = createClientRegistry([
      declareClientModule('counter', [
        declareView('test.counter', 'react', Counter, { props: { label: 'view' } }),
        declareView('test.counter', 'react +edit', Counter, { props: { label: 'edit' } }),
      ]),
    ]);
    const tree = (context: string) =>
      provide(
        registry,
        scope(context, createElement(Render, { value: { $type: 'test.counter' } })),
      );
    const result = render(tree('react'));
    fireEvent.click(result.getByRole('button'));
    result.rerender(tree('react +edit'));
    assert.equal(result.getByRole('button').textContent, 'edit:1');
    result.rerender(tree('react'));
    assert.equal(result.getByRole('button').textContent, 'view:1');
  });

  it('applies required selection to primitive field handlers', () => {
    const registry = createClientRegistry([
      declareClientModule('field', [
        declareView('string', 'react +edit', ({ value }) =>
          createElement('span', null, `edit:${value.value}`),
        ),
      ]),
    ]);
    const result = render(
      provide(registry, scope('react:cell !edit', createElement(RenderField, { value: 'price' }))),
    );
    assert.equal(result.container.textContent, 'edit:price');
    assert.throws(
      () =>
        render(
          provide(
            registry,
            scope('react !compact', createElement(RenderField, { value: 'price' })),
          ),
        ),
      {
        code: 'MISSING_REQUIRED_VARIANT',
      },
    );
  });
});
