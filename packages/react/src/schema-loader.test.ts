// useReg async-resolution race: a stale in-flight ensureType must not clobber
// the handler for the type currently being rendered.
//
// Run: npx tsx --import ./test/register-dom.mjs --import ./test/register-css.mjs \
//      --conditions development --experimental-test-module-mocks \
//      --test src/schema-loader.test.ts

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';

// Controllable trpc.get.query — one in-flight deferred we settle on demand.
let resolveQuery: (v: unknown) => void = () => {};
let rejectQuery: (e: unknown) => void = () => {};
const queryFn = mock.fn(() => new Promise<unknown>((res, rej) => { resolveQuery = res; rejectQuery = rej; }));
mock.module('#tree/trpc', {
  namedExports: { trpc: { get: { query: queryFn } } },
});

const { renderHook, act } = await import('@testing-library/react');
const { Component, createElement } = await import('react');
const { register, resolve } = await import('@treenx/core');
const { useReg, ensureType } = await import('./schema-loader');

// The shape a tRPC client failure carries its code in.
const trpcFailure = (code: string) => Object.assign(new Error(code), { data: { code } });

class Boundary extends Component<{ onError: (e: unknown) => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

describe('useReg async race', () => {
  it('stale in-flight resolution does not clobber the current type handler', async () => {
    const hB = () => null;                          // type B's react handler
    register('zz.race.b', 'react', hB);

    // type A is unregistered → first render triggers ensureType('zz.race.a')
    const { result, rerender } = renderHook(
      ({ t }: { t: string }) => useReg(t, 'react'),
      { initialProps: { t: 'zz.race.a' } },
    );
    assert.equal(result.current, undefined, 'A is loading');

    // switch to B before A settles → B resolves synchronously (registry hit)
    await act(async () => { rerender({ t: 'zz.race.b' }); });
    assert.equal(result.current, hB, 'B handler set');

    // A's in-flight fetch now settles — its stale .then must be ignored
    await act(async () => {
      resolveQuery({});
      await ensureType('zz.race.a');   // same memoized in-flight promise — drains the chain
    });

    assert.equal(result.current, hB, 'current type B handler preserved, not clobbered by A');
  });
});

describe('ensureType schema extraction', () => {
  // Regression: component-namespace migration moved named components under '#' keys —
  // type nodes serve the schema as '#schema', not bare 'schema'.
  it('registers schema served under the #schema component key', async () => {
    const schema = { $type: 'schema', $id: 'zz.ns.hashed', type: 'object', properties: {} };
    const p = ensureType('zz.ns.hashed');
    resolveQuery({ $path: '/sys/types/zz/ns/hashed', $type: 'type', '#schema': schema });
    await p;

    const handler = resolve('zz.ns.hashed', 'schema');
    assert.ok(handler, 'schema context registered');
    assert.deepEqual(handler(), schema);
  });
});

describe('ensureType failures', () => {
  it('a failed fetch rejects, and the next call asks again', async () => {
    const failure = trpcFailure('INTERNAL_SERVER_ERROR');
    const first = ensureType('zz.fail.retry');
    rejectQuery(failure);
    await assert.rejects(first, (e) => e === failure);

    const calls = queryFn.mock.callCount();
    const second = ensureType('zz.fail.retry');
    assert.equal(queryFn.mock.callCount(), calls + 1);
    resolveQuery(undefined);
    await second;
  });

  it('NOT_FOUND is a type without a schema, fetched once', async () => {
    const first = ensureType('zz.fail.absent');
    rejectQuery(trpcFailure('NOT_FOUND'));
    await first;

    const calls = queryFn.mock.callCount();
    await ensureType('zz.fail.absent');
    assert.equal(queryFn.mock.callCount(), calls);
  });

  it('useReg throws a failed fetch to the error boundary', async (t) => {
    t.mock.method(console, 'error', () => {});
    const failure = trpcFailure('FORBIDDEN');
    const caught: unknown[] = [];
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Boundary, { onError: (e) => caught.push(e) }, children);

    renderHook(() => useReg('zz.fail.hook', 'react'), { wrapper });
    await act(async () => {
      rejectQuery(failure);
      await assert.rejects(ensureType('zz.fail.hook'), (e) => e === failure);
    });

    assert.deepEqual(caught, [failure]);
  });
});
