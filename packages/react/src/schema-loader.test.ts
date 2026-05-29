// useReg async-resolution race: a stale in-flight ensureType must not clobber
// the handler for the type currently being rendered.
//
// Run: npx tsx --import ./test/register-dom.mjs --import ./test/register-css.mjs \
//      --conditions development --experimental-test-module-mocks \
//      --test src/schema-loader.test.ts

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Controllable trpc.get.query — one in-flight deferred we resolve on demand.
let resolveQuery: (v: unknown) => void = () => {};
const queryFn = mock.fn(() => new Promise<unknown>((res) => { resolveQuery = res; }));
mock.module('#tree/trpc', {
  namedExports: { trpc: { get: { query: queryFn } } },
});

const { renderHook, act } = await import('@testing-library/react');
const { register } = await import('@treenx/core');
const { useReg, ensureType } = await import('./schema-loader');

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
