// Tests for auto-save: pure functions + React hooks.
//
// Run: npx tsx --import ./test/register-dom.mjs --import ./test/register-css.mjs \
//      --conditions development --experimental-test-module-mocks \
//      --test src/tree/auto-save.test.ts

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock trpc before importing module under test
type Op = ['r', string, unknown] | ['d', string];
type PatchArg = { path: string; ops: Op[] };
const patchMutate = mock.fn(async (_: PatchArg) => {});
mock.module('./trpc', {
  namedExports: {
    trpc: { patch: { mutate: patchMutate } },
    getToken: () => null,
    setToken: () => {},
    clearToken: () => {},
    AUTH_EXPIRED_EVENT: 'trpc:auth-expired',
  },
});

const { renderHook, act } = await import('@testing-library/react');
const { mergeToOps, mergeIntoNode, useSave, usePathSave } = await import('./auto-save');
const cache = await import('#tree/cache');
const { makeNode } = await import('@treenx/core');

function seed(path: string, type: string, data?: Record<string, unknown>) {
  cache.put(makeNode(path, type, data));
  return cache.get(path)!;
}

beforeEach(() => {
  patchMutate.mock.resetCalls();
  cache.clear();
});

// ── Pure functions ──

describe('mergeToOps', () => {
  it('replace field', () => {
    const ops = mergeToOps({ title: 'new' });
    assert.deepEqual(ops, [['r', 'title', 'new']]);
  });

  it('delete field via undefined', () => {
    const ops = mergeToOps({ obsolete: undefined });
    assert.deepEqual(ops, [['d', 'obsolete']]);
  });

  it('dot-notation field', () => {
    const ops = mergeToOps({ 'meta.title': 'updated' });
    assert.deepEqual(ops, [['r', 'meta.title', 'updated']]);
  });

  it('mixed ops', () => {
    const ops = mergeToOps({ title: 'x', draft: undefined, 'meta.count': 5 });
    assert.equal(ops.length, 3);
    assert.deepEqual(ops[0], ['r', 'title', 'x']);
    assert.deepEqual(ops[1], ['d', 'draft']);
    assert.deepEqual(ops[2], ['r', 'meta.count', 5]);
  });

  it('skips $ fields', () => {
    const ops = mergeToOps({ $path: '/x', $type: 'y', title: 'z' });
    assert.deepEqual(ops, [['r', 'title', 'z']]);
  });

  it('skips invalid dot keys', () => {
    const ops = mergeToOps({ 'field..inner': 1, 'arr.0.name': 2, valid: 3 });
    assert.deepEqual(ops, [['r', 'valid', 3]]);
  });

  it('empty partial → empty ops', () => {
    assert.deepEqual(mergeToOps({}), []);
  });
});

describe('mergeIntoNode', () => {
  it('replaces top-level field', () => {
    const result = mergeIntoNode({ $path: '/x', $type: 'y', title: 'old' }, { title: 'new' });
    assert.equal(result.title, 'new');
    assert.equal(result.$path, '/x');
  });

  it('deletes field via undefined', () => {
    const result = mergeIntoNode({ $path: '/x', $type: 'y', draft: true }, { draft: undefined });
    assert.equal('draft' in result, false);
  });

  it('deep merge via dot-notation', () => {
    const node = { $path: '/x', $type: 'y', meta: { title: 'old', count: 0 } };
    const result = mergeIntoNode(node, { 'meta.title': 'new' });
    assert.equal((result.meta as Record<string, unknown>).title, 'new');
    assert.equal((result.meta as Record<string, unknown>).count, 0);
  });

  it('does not mutate original node', () => {
    const node = { $path: '/x', $type: 'y', meta: { title: 'old' } };
    mergeIntoNode(node, { 'meta.title': 'new' });
    assert.equal((node.meta as Record<string, unknown>).title, 'old');
  });

  it('skips $ fields', () => {
    const result = mergeIntoNode({ $path: '/x', $type: 'y' }, { $path: '/hacked' });
    assert.equal(result.$path, '/x');
  });
});

// ── useSave: onChange ──

describe('useSave: onChange', () => {
  it('exposes pending diff via value for instant form-local feedback', () => {
    seed('/a', 'task', { title: 'Old' });
    const { result } = renderHook(() => useSave('/a'));

    act(() => result.current.onChange({ title: 'New' }));

    // Form sees draft immediately via value (cached + pending merge)
    assert.equal(result.current.value!.title, 'New');
    // Cache stays at original until debounce fires or flush
    assert.equal(cache.get('/a')!.title, 'Old');
  });

  it('sets dirty=true', () => {
    seed('/b', 'task', { title: 'X' });
    const { result } = renderHook(() => useSave('/b'));

    assert.equal(result.current.dirty, false);
    act(() => result.current.onChange({ title: 'Y' }));
    assert.equal(result.current.dirty, true);
  });

  it('accumulates multiple changes in value', () => {
    seed('/c', 'task', { title: 'A', count: 0 });
    const { result } = renderHook(() => useSave('/c'));

    act(() => {
      result.current.onChange({ title: 'B' });
      result.current.onChange({ count: 5 });
    });

    const v = result.current.value!;
    assert.equal(v.title, 'B');
    assert.equal(v.count, 5);
  });

});

// ── useSave: flush ──

describe('useSave: flush', () => {
  it('sends ops via trpc.patch', async () => {
    seed('/e', 'task', { title: 'Old' });
    const { result } = renderHook(() => useSave('/e'));

    act(() => result.current.onChange({ title: 'New', draft: undefined }));
    await act(() => result.current.flush());

    assert.equal(patchMutate.mock.callCount(), 1);
    const arg = patchMutate.mock.calls[0].arguments[0];
    assert.equal(arg.path, '/e');
    assert.ok(arg.ops.some((op) => op[0] === 'r' && op[1] === 'title' && op[2] === 'New'));
    assert.ok(arg.ops.some((op) => op[0] === 'd' && op[1] === 'draft'));
  });

  it('clears dirty after flush', async () => {
    seed('/f', 'task', { title: 'X' });
    const { result } = renderHook(() => useSave('/f'));

    act(() => result.current.onChange({ title: 'Y' }));
    assert.equal(result.current.dirty, true);

    await act(() => result.current.flush());
    assert.equal(result.current.dirty, false);
  });

  it('noop when no pending changes', async () => {
    seed('/g', 'task', { title: 'X' });
    const { result } = renderHook(() => useSave('/g'));

    await act(() => result.current.flush());
    assert.equal(patchMutate.mock.callCount(), 0);
  });

  it('merges pending accumulated during inflight', async () => {
    seed('/inf', 'task', { title: 'A' });
    const { result } = renderHook(() => useSave('/inf'));

    act(() => result.current.onChange({ title: 'B' }));

    let flushDone: () => void;
    const slowPatch = new Promise<void>(r => { flushDone = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await slowPatch; });

    const flushPromise = act(() => result.current.flush());

    act(() => result.current.onChange({ title: 'C' }));

    flushDone!();
    await flushPromise;

    assert.equal(result.current.dirty, true);
  });
});

// ── useSave: reset ──

describe('useSave: reset', () => {
  it('discards pending — value reverts to cached node', () => {
    seed('/h', 'task', { title: 'Original' });
    const { result } = renderHook(() => useSave('/h'));

    act(() => result.current.onChange({ title: 'Modified' }));
    assert.equal(result.current.value!.title, 'Modified');

    act(() => result.current.reset());
    assert.equal(result.current.value!.title, 'Original');
    assert.equal(cache.get('/h')!.title, 'Original');
  });

  it('clears dirty', () => {
    seed('/i', 'task', { title: 'X' });
    const { result } = renderHook(() => useSave('/i'));

    act(() => result.current.onChange({ title: 'Y' }));
    act(() => result.current.reset());
    assert.equal(result.current.dirty, false);
  });
});

// ── useSave: scope ──

describe('useSave: scope', () => {
  it('prefixes keys for named component', async () => {
    seed('/j', 'task', { meta: { title: 'Old', count: 1 } });
    const { result } = renderHook(() => useSave('/j'));

    act(() => result.current.scope('meta')({ title: 'New' }));
    await act(() => result.current.flush());

    const { ops } = patchMutate.mock.calls[0].arguments[0];
    assert.deepEqual(ops, [['r', 'meta.title', 'New']]);
  });
});

// ── useSave: path change ──

describe('useSave: path change', () => {
  it('resets pending on path change', async () => {
    seed('/k1', 'task', { title: 'K1' });
    seed('/k2', 'task', { title: 'K2' });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useSave(path),
      { initialProps: { path: '/k1' } },
    );

    act(() => result.current.onChange({ title: 'Changed' }));
    assert.equal(result.current.dirty, true);

    rerender({ path: '/k2' });
    assert.equal(result.current.dirty, false);

    await act(() => result.current.flush());
    assert.equal(patchMutate.mock.callCount(), 0);
  });
});

// ── usePathSave: change ──

describe('usePathSave: change', () => {
  it('cache updates after flush — debounced fanout otherwise', async () => {
    seed('/p/a', 'col', { label: 'A' });
    seed('/p/b', 'col', { label: 'B' });
    const { result } = renderHook(() => usePathSave({ delay: 0 }));

    act(() => {
      result.current.change('/p/a', { label: 'A2' });
      result.current.change('/p/b', { label: 'B2' });
    });

    // Cache unchanged until debounce fires or flush
    assert.equal(cache.get('/p/a')!.label, 'A');
    assert.equal(cache.get('/p/b')!.label, 'B');

    await act(() => result.current.flush());
    assert.equal(cache.get('/p/a')!.label, 'A2');
    assert.equal(cache.get('/p/b')!.label, 'B2');
  });

  it('accumulates ops for same path', async () => {
    seed('/p/c', 'col', { label: 'C', rank: 0 });
    const { result } = renderHook(() => usePathSave({ delay: 0 }));

    act(() => {
      result.current.change('/p/c', { label: 'C2' });
      result.current.change('/p/c', { rank: 3 });
    });

    await act(() => result.current.flush());

    assert.equal(patchMutate.mock.callCount(), 1);
    const { ops } = patchMutate.mock.calls[0].arguments[0];
    assert.ok(ops.some((op) => op[1] === 'label'));
    assert.ok(ops.some((op) => op[1] === 'rank'));
  });
});

// ── usePathSave: path() ──

describe('usePathSave: path()', () => {
  it('returns stable cached handle', () => {
    const { result } = renderHook(() => usePathSave({ delay: 0 }));
    const h1 = result.current.path('/x');
    const h2 = result.current.path('/x');
    assert.equal(h1, h2);
  });

  it('different paths get different handles', () => {
    const { result } = renderHook(() => usePathSave({ delay: 0 }));
    const h1 = result.current.path('/x');
    const h2 = result.current.path('/y');
    assert.notEqual(h1, h2);
  });

  it('handle.onChange queues change — cache updates after flush', async () => {
    seed('/q', 'col', { label: 'Old' });
    const { result } = renderHook(() => usePathSave({ delay: 0 }));

    act(() => result.current.path('/q').onChange({ label: 'New' }));
    assert.equal(cache.get('/q')!.label, 'Old');

    await act(() => result.current.flush());
    assert.equal(cache.get('/q')!.label, 'New');
  });

  it('handle.scope prefixes keys', async () => {
    seed('/r', 'col', { meta: { x: 1 } });
    const { result } = renderHook(() => usePathSave({ delay: 0 }));

    act(() => result.current.path('/r').scope('meta')({ x: 2 }));
    await act(() => result.current.flush());

    const call = patchMutate.mock.calls[0].arguments[0];
    assert.equal(call.path, '/r');
    assert.deepEqual(call.ops, [['r', 'meta.x', 2]]);
  });
});

// ── usePathSave: flush ──

describe('usePathSave: flush', () => {
  it('sends ops for all accumulated paths', async () => {
    seed('/s/a', 'col', { label: 'A' });
    seed('/s/b', 'col', { label: 'B' });
    const { result } = renderHook(() => usePathSave({ delay: 0 }));

    act(() => {
      result.current.change('/s/a', { label: 'A2' });
      result.current.change('/s/b', { label: 'B2' });
    });

    await act(() => result.current.flush());

    assert.equal(patchMutate.mock.callCount(), 2);
    const paths = patchMutate.mock.calls.map((c) => c.arguments[0].path);
    assert.ok(paths.includes('/s/a'));
    assert.ok(paths.includes('/s/b'));
  });

  it('noop when no changes', async () => {
    const { result } = renderHook(() => usePathSave({ delay: 0 }));
    await act(() => result.current.flush());
    assert.equal(patchMutate.mock.callCount(), 0);
  });
});
