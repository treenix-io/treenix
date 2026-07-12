import { getCtx, predictionCtx, registerType } from '#comp';
import { resolve, type NodeData } from '#core';
import { clearRegistry } from '#testing';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('component actions without a server context runtime', () => {
  beforeEach(() => clearRegistry());

  it('runs context-free actions for optimistic prediction', () => {
    class Counter {
      count = 0;
      increment() { this.count++; }
    }
    registerType('browser.counter', Counter);
    const action = resolve('browser.counter', 'action:increment', false)!;
    const node: NodeData = { $path: '/counter', $type: 'browser.counter', count: 0 };

    action({ node }, {});

    assert.equal(node.count, 1);
  });

  // core-anz4.18: getCtx() must work for the synchronous span of a prediction —
  // before the fix ANY getCtx() call killed client-side prediction.
  it('exposes ctx to the synchronous span of an action', () => {
    class Renamer {
      rename(data: { title: string }) {
        const { node } = getCtx();
        node.title = data.title;
      }
    }
    registerType('browser.renamer', Renamer);
    const action = resolve('browser.renamer', 'action:rename', false)!;
    const node: NodeData = { $path: '/doc', $type: 'browser.renamer' };

    action(predictionCtx(node, node), { title: 'renamed' });

    assert.equal(node.title, 'renamed');
  });

  it('prediction ctx denies server-only fields with CTX_UNAVAILABLE', () => {
    class Saver {
      save() {
        const { tree } = getCtx();
        void tree;
      }
    }
    registerType('browser.saver', Saver);
    const action = resolve('browser.saver', 'action:save', false)!;
    const node: NodeData = { $path: '/doc', $type: 'browser.saver' };

    assert.throws(
      () => action(predictionCtx(node, node), {}),
      (e: unknown) => e instanceof Error && 'code' in e && e.code === 'CTX_UNAVAILABLE',
    );
  });

  it('does not expose ambient context across await', async () => {
    class ContextReader {
      async read() {
        await Promise.resolve();
        return getCtx().node.$path;
      }
    }
    registerType('browser.context-reader', ContextReader);
    const action = resolve('browser.context-reader', 'action:read', false)!;
    const node: NodeData = { $path: '/reader', $type: 'browser.context-reader' };

    await assert.rejects(() => action({ node }, {}), /outside action context/);
  });
});
