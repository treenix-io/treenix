import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { cleanup, renderHook } from '@testing-library/react';
import { Component, createElement, type ReactNode } from 'react';
import * as cache from '#tree/cache';
import { useEvalRef } from './hook';

class Boundary extends Component<{ onError: (e: unknown) => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

afterEach(() => { cleanup(); cache.clear(); });

it('useEvalRef delivers a pipe failure to the error boundary', (t) => {
  t.mock.method(console, 'error', () => {});
  cache.put({ $path: '/binding', $type: 't.dir', value: 1n });
  const caught: unknown[] = [];
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Boundary, { onError: (e) => caught.push(e) }, children);

  renderHook(() => useEvalRef('/binding', '.value | round'), { wrapper });

  assert.equal(caught.length, 1);
  assert.ok(caught[0] instanceof TypeError);
});
