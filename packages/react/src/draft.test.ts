// React hook tests for useDraft.
// Run: npx tsx --import ./test/register-dom.mjs --import ./test/register-css.mjs \
//      --conditions development --test src/draft.test.ts
//
// Note: commit() calls createNode (server persist) which can't be mocked
// because #hooks is a subpath import (Node.js mock.module limitation).
// Data-cleaning logic for commit is tested via vanilla valtio below.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHook, act } from '@testing-library/react';
import { makeNode, type NodeData } from '@treenx/core';
import { $key, $node, stampNode } from '#symbols';
import { viewCtx } from '#context';
import { proxy, snapshot } from 'valtio/vanilla';
import { useDraft } from './draft';

// ── vanilla helpers (no React) ──

function draftNode(type: string, initial?: Record<string, unknown>): NodeData {
  const n = makeNode(`/draft/${crypto.randomUUID()}`, type, initial);
  stampNode(n);
  return n;
}

function cleanData(node: NodeData): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!k.startsWith('$')) data[k] = v;
  }
  return data;
}

// ── React hook: create ──

describe('useDraft: create', () => {
  it('starts with node = null', () => {
    const { result } = renderHook(() => useDraft('board.task'));
    assert.equal(result.current.node, null);
  });

  it('create() produces a stamped node with correct type', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create());

    const node = result.current.node!;
    assert.ok(node);
    assert.equal(node.$type, 'board.task');
    assert.ok(node.$path.startsWith('/draft/'));
  });

  it('create() stamps $node and $key symbols', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create());

    const node = result.current.node!;
    assert.ok((node as any)[$node]);
    assert.equal((node as any)[$key], '');
  });

  it('create() with initial data', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: 'Hello', priority: 'high' }));

    const node = result.current.node!;
    assert.equal((node as any).title, 'Hello');
    assert.equal((node as any).priority, 'high');
  });

  it('viewCtx works on the draft node', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: 'Test' }));

    const ctx = viewCtx(result.current.node!);
    assert.ok(ctx);
    assert.equal(ctx.path, result.current.node!.$path);
  });

  it('create() replaces existing draft', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: 'First' }));
    const firstPath = result.current.node!.$path;

    await act(async () => result.current.create({ title: 'Second' }));
    assert.notEqual(result.current.node!.$path, firstPath);
    assert.equal((result.current.node as any).title, 'Second');
  });
});

// ── React hook: onChange ──

describe('useDraft: onChange', () => {
  it('updates fields on the draft', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: '', count: 0 }));
    await act(async () => result.current.onChange({ title: 'Updated' }));

    assert.equal((result.current.node as any).title, 'Updated');
    assert.equal((result.current.node as any).count, 0);
  });

  it('adds new fields', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: 'A' }));
    await act(async () => result.current.onChange({ description: 'New' }));

    assert.equal((result.current.node as any).description, 'New');
    assert.equal((result.current.node as any).title, 'A');
  });

  it('multiple mutations accumulate', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: '', x: 0 }));
    await act(async () => {
      result.current.onChange({ title: 'Step 1' });
      result.current.onChange({ x: 1 });
      result.current.onChange({ title: 'Step 2', extra: true });
    });

    assert.equal((result.current.node as any).title, 'Step 2');
    assert.equal((result.current.node as any).x, 1);
    assert.equal((result.current.node as any).extra, true);
  });

  it('no-op when no draft exists', async () => {
    const { result } = renderHook(() => useDraft('board.task'));
    await act(async () => result.current.onChange({ title: 'X' }));
    assert.equal(result.current.node, null);
  });

  it('symbols survive after onChange', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: '' }));
    await act(async () => result.current.onChange({ title: 'Changed' }));

    assert.ok((result.current.node as any)[$node]);
    assert.equal((result.current.node as any)[$key], '');
  });
});

// ── React hook: close ──

describe('useDraft: close', () => {
  it('discards draft without persisting', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: 'Discard me' }));
    assert.ok(result.current.node);

    await act(async () => result.current.close());
    assert.equal(result.current.node, null);
  });

  it('close is no-op when no draft exists', async () => {
    const { result } = renderHook(() => useDraft('board.task'));
    await act(async () => result.current.close());
    assert.equal(result.current.node, null);
  });
});

// ── React hook: lifecycle ──

describe('useDraft: lifecycle', () => {
  it('create → close → create works cleanly', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: 'Abandoned' }));
    await act(async () => result.current.close());
    assert.equal(result.current.node, null);

    await act(async () => result.current.create({ title: 'Fresh' }));
    assert.equal((result.current.node as any).title, 'Fresh');
  });

  it('viewCtx works after create → close → create cycle', async () => {
    const { result } = renderHook(() => useDraft('board.task'));

    await act(async () => result.current.create({ title: 'A' }));
    await act(async () => result.current.close());
    await act(async () => result.current.create({ title: 'B' }));

    const ctx = viewCtx(result.current.node!);
    assert.ok(ctx);
    assert.equal(ctx.path, result.current.node!.$path);
  });
});

// ── vanilla: commit data cleaning (no React needed) ──

describe('commit data cleaning', () => {
  it('strips $-prefixed fields, keeps user data', () => {
    const n = draftNode('board.task', { title: 'My Task', status: 'backlog', priority: 2 });
    const data = cleanData(n);

    assert.deepEqual(data, { title: 'My Task', status: 'backlog', priority: 2 });
  });

  it('preserves nested objects', () => {
    const n = draftNode('test', { config: { a: 1, b: [2, 3] }, label: 'ok' });
    const data = cleanData(n);
    assert.deepEqual(data, { config: { a: 1, b: [2, 3] }, label: 'ok' });
  });

  it('empty node produces empty data', () => {
    const n = draftNode('test');
    assert.deepEqual(cleanData(n), {});
  });

  it('works on proxied node after mutations', () => {
    const n = draftNode('board.task', { title: 'Original', count: 42 });
    const state = proxy<{ node: NodeData | null }>({ node: n });

    Object.assign(state.node!, { title: 'Mutated' });

    const data = cleanData(state.node!);
    assert.equal(data.title, 'Mutated');
    assert.equal(data.count, 42);
    assert.equal(data.$path, undefined);
    assert.equal(data.$type, undefined);
  });
});

// ── vanilla: valtio symbol survival ──

describe('valtio symbol survival', () => {
  it('symbols survive proxy wrapping', () => {
    const n = draftNode('test', { x: 1 });
    const state = proxy<{ node: NodeData | null }>({ node: n });

    assert.equal((state.node as any)[$node], n);
    assert.equal((state.node as any)[$key], '');
  });

  it('symbols survive Object.assign mutation', () => {
    const n = draftNode('test', { x: 1 });
    const state = proxy<{ node: NodeData | null }>({ node: n });

    Object.assign(state.node!, { x: 2, y: 3 });

    assert.equal((state.node as any)[$node], n);
    assert.equal((state.node as any)[$key], '');
  });

  it('snapshot preserves symbols', () => {
    const n = draftNode('test', { title: 'hello' });
    const state = proxy<{ node: NodeData | null }>({ node: n });
    const snap = snapshot(state);

    assert.ok((snap.node as any)[$node]);
    assert.equal((snap.node as any)[$key], '');
  });

  it('viewCtx works on snapshot', () => {
    const n = draftNode('board.task', { title: 'Test' });
    const state = proxy<{ node: NodeData | null }>({ node: n });
    const snap = snapshot(state);

    const ctx = viewCtx(snap.node as NodeData);
    assert.ok(ctx);
    assert.equal(ctx.path, n.$path);
  });

  it('component-level symbols survive proxy', () => {
    const n = draftNode('board.task', {
      checklist: { $type: 'simple.checklist', items: [] },
    });
    const state = proxy<{ node: NodeData | null }>({ node: n });

    const proxied = (state.node as any).checklist;
    assert.equal(proxied[$key], 'checklist');
    assert.equal(proxied[$node], n);
  });
});
