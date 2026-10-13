import { CtxUnavailableError, getCtx } from '#comp';
import { declareClientType } from '#comp/client-declaration';
import type { NodeData } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('component actions without a server context runtime', () => {
  it('runs context-free actions for optimistic prediction', () => {
    class Counter {
      count = 0;
      increment() { this.count++; }
    }
    const action = declareClientType('browser.counter', Counter).predictions.increment;
    const node: NodeData = { $path: '/counter', $type: 'browser.counter', count: 0 };

    action(node, node, {});

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
    const action = declareClientType('browser.renamer', Renamer).predictions.rename;
    const node: NodeData = { $path: '/doc', $type: 'browser.renamer' };

    action(node, node, { title: 'renamed' });

    assert.equal(node.title, 'renamed');
  });

  it('prediction ctx denies server-only fields with CTX_UNAVAILABLE', () => {
    class Saver {
      save() {
        const { tree } = getCtx();
        void tree;
      }
    }
    const action = declareClientType('browser.saver', Saver).predictions.save;
    const node: NodeData = { $path: '/doc', $type: 'browser.saver' };

    assert.throws(
      () => action(node, node, {}),
      (e: unknown) => e instanceof CtxUnavailableError && e.code === 'CTX_UNAVAILABLE',
    );
  });

  it('does not expose ambient context across await', async () => {
    class ContextReader {
      async read() {
        await Promise.resolve();
        return getCtx().node.$path;
      }
    }
    const action = declareClientType('browser.context-reader', ContextReader).predictions.read;
    const node: NodeData = { $path: '/reader', $type: 'browser.context-reader' };

    await assert.rejects(async () => await action(node, node, {}),
      (e: unknown) => e instanceof CtxUnavailableError && e.code === 'CTX_UNAVAILABLE');
  });
});
