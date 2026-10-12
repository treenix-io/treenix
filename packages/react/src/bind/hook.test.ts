import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { cleanup, renderHook } from '@testing-library/react';
import { Component, createElement, type ReactNode } from 'react';
import { TreeSourceProvider } from '#tree/tree-source-context';
import { EMPTY_CHILDREN_SNAPSHOT, NOOP_CHILDREN_HANDLE, NOOP_PATH_HANDLE, type TreeSource } from '#tree/tree-source';
import { useEvalRef } from './hook';

class Boundary extends Component<{ onError: (e: unknown) => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

afterEach(() => cleanup());

it('useEvalRef delivers a pipe failure to the error boundary', (t) => {
  t.mock.method(console, 'error', () => {});
  const snapshot = { data: { $path: '/binding', $type: 't.dir', value: 1n }, status: 'ready' as const, error: null };
  const source: TreeSource = {
    getPathSnapshot: () => snapshot,
    getChildrenSnapshot: () => EMPTY_CHILDREN_SNAPSHOT,
    subscribePath: () => () => {},
    subscribeChildren: () => () => {},
    mountPath: () => NOOP_PATH_HANDLE,
    mountChildren: () => NOOP_CHILDREN_HANDLE,
  };
  const caught: unknown[] = [];
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Boundary, { onError: (e) => caught.push(e) },
      createElement(TreeSourceProvider, { source, children }));

  renderHook(() => useEvalRef('/binding', '.value | round'), { wrapper });

  assert.equal(caught.length, 1);
  assert.ok(caught[0] instanceof TypeError);
});
