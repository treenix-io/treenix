import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import type { NodeData } from '@treenx/core';

mock.module('#tree/trpc', { namedExports: {
  trpc: {}, tabTokenInput: { token: 'test-tab' },
  getToken: () => null, setToken: () => {}, clearToken: () => {}, AUTH_EXPIRED_EVENT: 'trpc:auth-expired',
} });

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { resolve } = await import('@treenx/core');
const { NodeProvider } = await import('./context/index.tsx');
const { TreeSourceProvider } = await import('#tree/tree-source-context');
const { EMPTY_PATH_SNAPSHOT, EMPTY_CHILDREN_SNAPSHOT, NOOP_PATH_HANDLE, NOOP_CHILDREN_HANDLE } = await import('#tree/tree-source');
await import('../../../mods/whisper/react');
import type { TreeSource } from '#tree/tree-source';

function render(children: NodeData[]): string {
  const node = { $path: '/channel', $type: 'whisper.channel' };
  const source: TreeSource = {
    getPathSnapshot: () => EMPTY_PATH_SNAPSHOT,
    getChildrenSnapshot: () => ({ ...EMPTY_CHILDREN_SNAPSHOT, data: children }),
    subscribePath: () => () => {}, subscribeChildren: () => () => {},
    mountPath: () => NOOP_PATH_HANDLE, mountChildren: () => NOOP_CHILDREN_HANDLE,
  };
  const View = resolve('whisper.channel', 'react')!;
  return renderToStaticMarkup(createElement(TreeSourceProvider, { source, children:
    createElement(NodeProvider, { value: node }, createElement(View, { value: node, ctx: { node, path: node.$path, execute: async () => undefined } })),
  }));
}

it('renders persisted namespaced transcription text and metadata', () => {
  const html = render([{ $path: '/channel/note', $type: 'whisper.transcription',
    '#text': { $type: 'whisper.text', content: 'Meeting note' },
    '#meta': { $type: 'whisper.meta', duration: 12 },
  }]);
  assert.ok(html.includes('Meeting note'));
  assert.ok(html.includes('12s'));
  assert.ok(!html.includes('No transcriptions yet'));
});

it('renders pending transcriptions and fails loudly when their text component is missing', () => {
  const html = render([{ $path: '/channel/pending', $type: 'whisper.transcription', '#text': { $type: 'whisper.text', content: '...' } }]);
  assert.ok(html.includes('transcribing'));
  assert.throws(() => render([{ $path: '/channel/broken', $type: 'whisper.transcription' }]), Error);
});
