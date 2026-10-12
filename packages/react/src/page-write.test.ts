import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { NodeData } from '@treenx/core';
import type { TreeSource } from '#tree/tree-source';

const React = await import('react');
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { createNode, register } = await import('@treenx/core');
const { applyOps } = await import('@treenx/core/tree');
const { Render } = await import('./context/index.tsx');
const { NavigateProvider, makeNavigateApi } = await import('#navigate');
const { READ_ONLY_EFFECTS } = await import('#tree/effects');
const { mergeToOps } = await import('#tree/on-change');
const { TreeSourceProvider } = await import('#tree/tree-source-context');
const { EMPTY_PATH_SNAPSHOT, EMPTY_CHILDREN_SNAPSHOT, NOOP_PATH_HANDLE, NOOP_CHILDREN_HANDLE } =
  await import('#tree/tree-source');

const source: TreeSource = {
  getPathSnapshot: () => EMPTY_PATH_SNAPSHOT,
  getChildrenSnapshot: () => EMPTY_CHILDREN_SNAPSHOT,
  subscribePath: () => () => {},
  subscribeChildren: () => () => {},
  mountPath: () => NOOP_PATH_HANDLE,
  mountChildren: () => NOOP_CHILDREN_HANDLE,
};

for (const legacy of [false, true]) {
  it(
    `page command edits preserve neighbors ${legacy ? 'and remove a legacy component once' : 'without a legacy component'}`,
    { timeout: 3000 },
    async (t) => {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'React');
      // The mod uses automatic JSX in Vite; the Node runner compiles its TSX with the classic runtime.
      Object.defineProperty(globalThis, 'React', { value: React, configurable: true });
      t.after(() => {
        cleanup();
        if (original) Object.defineProperty(globalThis, 'React', original);
        else Reflect.deleteProperty(globalThis, 'React');
      });
      const { PageLayoutView } = await import('../../../mods/brahman/views/page-layout');
      register('brahman.page', 'react', PageLayoutView);
      const persisted: NodeData = createNode('/page', 'brahman.page', {
        command: '/start',
        positions: [],
        retained: 7,
        ...(legacy ? { page: {} } : {}),
      });
      let node = structuredClone(persisted);
      const listeners = new Set<() => void>();
      let saved!: () => void;
      const owned: TreeSource = {
        ...source,
        subscribePath(_path, listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getPathSnapshot: (path) =>
          path === node.$path ? { data: node, status: 'ready', error: null } : EMPTY_PATH_SNAPSHOT,
        effects: {
          ...READ_ONLY_EFFECTS,
          async patchNode(path, partial) {
            assert.equal(path, persisted.$path);
            applyOps(persisted, mergeToOps(partial));
            node = structuredClone(persisted);
            for (const listener of listeners) listener();
            saved();
          },
        },
      };
      const view = render(
        React.createElement(TreeSourceProvider, {
          source: owned,
          children: React.createElement(NavigateProvider, {
            value: makeNavigateApi(
              () => true,
              (path) => path,
            ),
            children: React.createElement(Render, { value: node }),
          }),
        }),
      );
      for (const command of ['/accepted', '/second']) {
        const finished = new Promise<void>((resolve) => {
          saved = resolve;
        });
        const input = view.getByPlaceholderText('/command...');
        fireEvent.change(input, { target: { value: command } });
        fireEvent.blur(input);
        await act(() => finished);
        assert.equal(persisted.command, command);
        assert.equal(persisted.retained, 7);
        assert.equal(Object.hasOwn(persisted, 'page'), false);
      }
    },
  );
}
