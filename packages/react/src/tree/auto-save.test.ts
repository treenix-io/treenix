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
const { mergeToOps, mergeIntoNode, useSave, useAutoSave, usePathSave } = await import('./auto-save');
const cache = await import('#tree/cache');
const { makeNode } = await import('@treenx/core');
const { $key, $node } = await import('#symbols');

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

  it('preserves original node context on pending value for Render/useActions', () => {
    const original = seed('/ctx', 'task', { title: 'Old' });
    const { result } = renderHook(() => useSave('/ctx'));

    act(() => result.current.onChange({ title: 'New' }));

    assert.equal((result.current.value as any)[$node], original);
    assert.notEqual(result.current.value, original);
  });

  it('preserves original node context on pending named components', () => {
    const original = seed('/ctx-comp', 'task', {
      meta: { $type: 'task.meta', title: 'Old' },
    });
    const { result } = renderHook(() => useSave('/ctx-comp'));

    act(() => result.current.scope('meta')({ title: 'New' }));

    const meta = (result.current.value as any).meta;
    assert.equal(meta.title, 'New');
    assert.equal(meta[$node], original);
    assert.equal(meta[$key], 'meta');
    assert.notEqual(meta, (original as any).meta);
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

  it('rejects on patch failure and restores pending — edits are not lost (cnr.5 C21)', async () => {
    seed('/fail', 'task', { title: 'Old' });
    const { result } = renderHook(() => useSave('/fail'));

    act(() => result.current.onChange({ title: 'New' }));
    patchMutate.mock.mockImplementationOnce(async () => { throw new Error('FORBIDDEN'); });

    let err: unknown;
    await act(async () => { err = await result.current.flush().catch(e => e); });

    assert.ok(err instanceof Error, 'flush rejected — caller must not toast Saved');
    assert.equal(result.current.dirty, true, 'pending restored, still dirty');

    // Retry succeeds and re-sends the SAME ops
    await act(() => result.current.flush());
    assert.equal(result.current.dirty, false);
    const retry = patchMutate.mock.calls.at(-1)!.arguments[0];
    assert.ok(retry.ops.some((op) => op[0] === 'r' && op[1] === 'title' && op[2] === 'New'));
  });

  it('failed flush keeps edits typed during the round-trip (new edits win)', async () => {
    seed('/fail2', 'task', { title: 'A', count: 0 });
    const { result } = renderHook(() => useSave('/fail2'));

    act(() => result.current.onChange({ title: 'B', count: 1 }));

    let failFlush: () => void;
    const gate = new Promise<void>((_, rej) => { failFlush = () => rej(new Error('boom')); });
    patchMutate.mock.mockImplementationOnce(async () => gate);

    let flushed: Promise<unknown>;
    act(() => { flushed = result.current.flush().catch(e => e); });
    act(() => result.current.onChange({ title: 'C' }));
    failFlush!();
    await act(async () => { await flushed; });

    // Restored pending: in-flight fields merged back, newer edit wins
    const v = result.current.value!;
    assert.equal(v.title, 'C');
    assert.equal(v.count, 1);
    assert.equal(result.current.dirty, true);
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

// ── useSave: cancel pending auto-save (core-anz4.17) ──

describe('useSave: cancel pending auto-save (core-anz4.17)', () => {
  it('discard cancels the armed auto-save timer — no flush fires after the delay', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    seed('/cancel', 'task', { title: 'A' });
    const { result } = renderHook(() => useAutoSave('/cancel', { delay: 100 }));

    act(() => result.current.onChange({ title: 'B' })); // arms the debounced auto-save
    act(() => result.current.discard());                // JSON-tab open / explicit JSON Save cancels it

    act(() => t.mock.timers.tick(500));                 // well past the delay
    assert.equal(patchMutate.mock.callCount(), 0, 'canceled auto-save must not flush');
    assert.equal(result.current.dirty, false);
  });

  it('control: an armed auto-save timer DOES flush after the delay', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    seed('/arm', 'task', { title: 'A' });
    const { result } = renderHook(() => useAutoSave('/arm', { delay: 100 }));

    act(() => result.current.onChange({ title: 'B' }));
    act(() => t.mock.timers.tick(500));
    assert.equal(patchMutate.mock.callCount(), 1, 'armed timer fired the flush');
  });
});

// ── useSave: flush during inflight (verify-index 27) ──

describe('useSave: flush during inflight (verify-index 27)', () => {
  it('does not resolve until the inflight request really commits', async () => {
    seed('/inflight-await', 'task', { title: 'A' });
    const { result } = renderHook(() => useSave('/inflight-await'));
    act(() => result.current.onChange({ title: 'B' }));

    let release: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gate; });

    let flush1: Promise<unknown> | undefined;
    let flush2: Promise<unknown> | undefined;
    act(() => { flush1 = result.current.flush(); });
    act(() => { flush2 = result.current.flush(); });

    let flush2Settled = false;
    flush2!.then(() => { flush2Settled = true; }, () => { flush2Settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(flush2Settled, false, 'flush() during inflight must await the real commit, not resolve early');

    release!();
    await act(async () => { await Promise.all([flush1, flush2]); });
    assert.equal(flush2Settled, true);
    assert.equal(patchMutate.mock.callCount(), 1, 'the second flush chained, did not re-send');
  });

  it('rejects when the inflight request rejects', async () => {
    seed('/inflight-reject', 'task', { title: 'A' });
    const { result } = renderHook(() => useSave('/inflight-reject'));
    act(() => result.current.onChange({ title: 'B' }));

    let fail: () => void;
    const gate = new Promise<void>((_, rej) => { fail = () => rej(new Error('boom')); });
    patchMutate.mock.mockImplementationOnce(async () => gate);

    let flush1: Promise<unknown> | undefined;
    let flush2: Promise<unknown> | undefined;
    act(() => { flush1 = result.current.flush().catch((e) => e); });
    act(() => { flush2 = result.current.flush(); });

    fail!();
    await act(async () => {
      await flush1;
      await assert.rejects(() => flush2!, (e) => e instanceof Error);
    });
  });
});

// ── useSave: stale badge (own-rev counting reverted, core-anz4.17) ──

describe('useSave: stale badge (core-anz4.17)', () => {
  it('foreign rev bump trips stale', () => {
    cache.put({ ...makeNode('/foreign', 'task', { title: 'A' }), $rev: 1 });
    const { result } = renderHook(() => useSave('/foreign'));

    act(() => result.current.onChange({ title: 'B' })); // editing at rev 1, dirty
    act(() => { cache.put({ ...makeNode('/foreign', 'task', { title: 'X' }), $rev: 2 }); });

    assert.equal(result.current.dirty, true);
    assert.equal(result.current.stale, true, 'external change surfaces as stale');
  });

  it('a foreign rev after an own write echo is never swallowed (rev-counting was wrong)', async () => {
    // Reproduces the reviewer scenario: the own write's SSE echo lands BEFORE
    // the mutate response, then a genuine foreign write follows. The old
    // ownBumps counter, incremented only after the response, was left over and
    // swallowed this foreign bump — hiding the conflict. Counting rev bumps
    // cannot tell own from foreign, so we no longer try.
    cache.put({ ...makeNode('/noswallow', 'task', { title: 'A' }), $rev: 1 });
    const { result } = renderHook(() => useSave('/noswallow'));

    act(() => result.current.onChange({ title: 'B' })); // edit at rev 1, editRev=1, dirty

    let commit: () => void;
    const gate = new Promise<void>((r) => { commit = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gate; });

    let flushing: Promise<unknown> | undefined;
    act(() => { flushing = result.current.flush(); });
    act(() => result.current.onChange({ title: 'C' })); // pending accumulates → stays dirty

    // Own write's SSE echo arrives BEFORE the mutate response resolves.
    act(() => { cache.put({ ...makeNode('/noswallow', 'task', { title: 'B' }), $rev: 2 }); });
    commit!();
    await act(async () => { await flushing; });

    // Genuine foreign write bumps rev again.
    act(() => { cache.put({ ...makeNode('/noswallow', 'task', { title: 'X' }), $rev: 3 }); });

    assert.equal(result.current.dirty, true);
    assert.equal(result.current.stale, true, 'foreign rev after own echo must still surface — not swallowed');
  });
});

// ── useSave: settle serializes a full-set against an in-flight patch (core-anz4.17) ──

describe('useSave: settle vs in-flight patch (core-anz4.17)', () => {
  it('settle awaits the in-flight patch; discard then drops parked pending so a full-set is not clobbered', async () => {
    seed('/jsonrace', 'task', { title: 'A' });
    const { result } = renderHook(() => useSave('/jsonrace'));

    act(() => result.current.onChange({ title: 'B' }));

    let land: () => void;
    const gate = new Promise<void>((r) => { land = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gate; });

    let flushing: Promise<unknown> | undefined;
    act(() => { flushing = result.current.flush().catch((e) => e); }); // patch parked in flight
    act(() => result.current.onChange({ title: 'B2' }));               // pending accumulates during round-trip

    let settled = false;
    let settleP: Promise<void> | undefined;
    act(() => { settleP = result.current.settle().then(() => { settled = true; }); });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false, 'settle must not resolve while the patch is still in flight');

    land!();
    await act(async () => { await flushing; await settleP; });
    assert.equal(settled, true);
    assert.equal(patchMutate.mock.callCount(), 1, 'only the in-flight patch was sent');

    // JSON Save: drop parked pending, then full-set the whole node.
    act(() => result.current.discard());
    act(() => { cache.put(makeNode('/jsonrace', 'task', { title: 'JSON' })); });

    assert.equal(cache.get('/jsonrace')!.title, 'JSON', 'full-set is the final stored state');
    assert.equal(patchMutate.mock.callCount(), 1, 'discard prevented a parked patch from clobbering the set');
    assert.equal(result.current.dirty, false);
  });

  it('a stale settle on an old path does not wipe the new path in-flight patch', async () => {
    seed('/pa', 'task', { title: 'A' });
    seed('/pb', 'task', { title: 'B' });
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useSave(path),
      { initialProps: { path: '/pa' } },
    );

    act(() => result.current.onChange({ title: 'A2' }));
    let landA: () => void;
    const gateA = new Promise<void>((r) => { landA = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gateA; });
    let flushA: Promise<unknown> | undefined;
    act(() => { flushA = result.current.flush().catch((e) => e); }); // runA in flight on /pa

    rerender({ path: '/pb' });

    act(() => result.current.onChange({ title: 'B2' }));
    let landB: () => void;
    const gateB = new Promise<void>((r) => { landB = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gateB; });
    let flushB: Promise<unknown> | undefined;
    act(() => { flushB = result.current.flush().catch((e) => e); }); // runB in flight on /pb

    // Old path's patch settles — its finally must NOT null the new path's slot.
    landA!();
    await act(async () => { await flushA; });

    let bSettled = false;
    let settleP: Promise<void> | undefined;
    act(() => { settleP = result.current.settle().then(() => { bSettled = true; }); });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(bSettled, false, 'settle must still await /pb in-flight patch — stale settle must not have wiped it');

    landB!();
    await act(async () => { await flushB; await settleP; });
    assert.equal(bSettled, true);
    assert.equal(patchMutate.mock.callCount(), 2, 'one patch per path — no re-send');
  });

  it('a stale /a run rejecting does not pollute /b pending nor drop /b in-flight (r2)', async () => {
    seed('/ra', 'task', { title: 'A' });
    seed('/rb', 'task', { title: 'B' });
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useSave(path),
      { initialProps: { path: '/ra' } },
    );

    act(() => result.current.onChange({ title: 'A2', fromA: 'leak' }));
    let failA: () => void;
    const gateA = new Promise<void>((_, rej) => { failA = () => rej(new Error('boom')); });
    patchMutate.mock.mockImplementationOnce(async () => gateA);
    let flushA: Promise<unknown> | undefined;
    act(() => { flushA = result.current.flush().catch((e) => e); }); // runA in flight on /ra

    rerender({ path: '/rb' });

    act(() => result.current.onChange({ title: 'B2' }));
    let landB: () => void;
    const gateB = new Promise<void>((r) => { landB = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gateB; });
    let flushB: Promise<unknown> | undefined;
    act(() => { flushB = result.current.flush().catch((e) => e); }); // runB in flight on /rb
    act(() => result.current.onChange({ extra: 'B3' }));             // /rb pending accumulates

    // Stale /ra run rejects — must NOT restore /ra's partial into /rb pending.
    failA!();
    await act(async () => { await flushA; });

    const v = result.current.value!;
    assert.equal(v.title, 'B2', "/rb value keeps its own title, not /ra's A2");
    assert.equal('fromA' in v, false, "/ra fields must not leak into /rb pending");
    assert.equal(v.extra, 'B3');
    assert.equal(result.current.dirty, true, '/rb stays dirty (pending + in-flight)');

    // settle must still await /rb — the stale reject must not have cleared inflight.
    let bSettled = false;
    let settleP: Promise<void> | undefined;
    act(() => { settleP = result.current.settle().then(() => { bSettled = true; }); });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(bSettled, false, 'settle awaits /rb — stale reject did not drop its in-flight patch');

    landB!();
    await act(async () => { await flushB; await settleP; });
    assert.equal(bSettled, true);
  });

  it('a stale /a run succeeding does not clearEdit for /b — stale detection survives (r2)', async () => {
    cache.put({ ...makeNode('/sa', 'task', { title: 'A' }), $rev: 1 });
    cache.put({ ...makeNode('/sb', 'task', { title: 'B' }), $rev: 1 });
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useSave(path),
      { initialProps: { path: '/sa' } },
    );

    act(() => result.current.onChange({ title: 'A2' }));
    let landA: () => void;
    const gateA = new Promise<void>((r) => { landA = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gateA; });
    let flushA: Promise<unknown> | undefined;
    act(() => { flushA = result.current.flush().catch((e) => e); }); // runA in flight on /sa

    rerender({ path: '/sb' });

    act(() => result.current.onChange({ title: 'B2' }));             // edits /sb at rev 1, editRev=1
    let landB: () => void;
    const gateB = new Promise<void>((r) => { landB = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gateB; });
    let flushB: Promise<unknown> | undefined;
    act(() => { flushB = result.current.flush().catch((e) => e); }); // runB in flight on /sb, pending null

    // Stale /sa run SUCCEEDS — its success branch must not clearEdit() for /sb.
    landA!();
    await act(async () => { await flushA; });

    // Genuine foreign write on /sb bumps rev — must still surface as stale.
    act(() => { cache.put({ ...makeNode('/sb', 'task', { title: 'X' }), $rev: 2 }); });

    assert.equal(result.current.dirty, true, '/sb still dirty (in-flight)');
    assert.equal(result.current.stale, true, 'editRev intact — stale detection not wiped by stale run');

    landB!();
    await act(async () => { await flushB; });
  });

  it('a flush chained behind an inflight run does not fire for the new path after a switch (r2)', async () => {
    seed('/ca', 'task', { title: 'A' });
    seed('/cb', 'task', { title: 'B' });
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useSave(path),
      { initialProps: { path: '/ca' } },
    );

    act(() => result.current.onChange({ title: 'A2' }));
    let landA: () => void;
    const gateA = new Promise<void>((r) => { landA = r; });
    patchMutate.mock.mockImplementationOnce(async () => { await gateA; }); // runA (patch #1)
    let flushA: Promise<unknown> | undefined;
    act(() => { flushA = result.current.flush().catch((e) => e); });        // runA in flight on /ca
    // Second flush parks on the inflight run — captures /ca's generation.
    let flush2: Promise<unknown> | undefined;
    act(() => { flush2 = result.current.flush().catch((e) => e); });

    rerender({ path: '/cb' });                                              // genRef++
    act(() => result.current.onChange({ title: 'B2' }));                    // /cb pending

    landA!();                                                              // runA settles
    await act(async () => { await flushA; await flush2; });

    // The chained flush2 belongs to /ca — it must NOT have sent /cb's pending.
    assert.equal(patchMutate.mock.calls.length, 1, 'stale chained flush must not fire a patch for /cb');
    assert.equal(result.current.dirty, true, '/cb pending is still unsent');
    assert.equal(result.current.value!.title, 'B2', '/cb keeps its own pending edit');

    // An explicit /cb flush now genuinely sends it.
    const gateB = new Promise<void>((r) => { r(); });
    patchMutate.mock.mockImplementationOnce(async () => { await gateB; });
    await act(async () => { await result.current.flush(); });
    assert.equal(patchMutate.mock.calls.length, 2, 'explicit /cb flush sends the pending patch');
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

// ── useSave: discard ──

describe('useSave: discard', () => {
  it('drops pending WITHOUT rolling the cache back (post-set consume, cnr.5 C21)', () => {
    seed('/dc', 'task', { title: 'Old' });
    const { result } = renderHook(() => useSave('/dc'));

    act(() => result.current.onChange({ title: 'New' }));

    // Another channel persisted the draft (e.g. full-node set) — cache holds fresh state.
    act(() => { cache.put(makeNode('/dc', 'task', { title: 'New' })); });

    act(() => result.current.discard());

    assert.equal(result.current.dirty, false);
    assert.equal(cache.get('/dc')!.title, 'New', 'freshly-saved state NOT rolled back (reset() would restore Old)');
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
