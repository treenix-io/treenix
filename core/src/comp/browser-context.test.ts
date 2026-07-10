import { getCtx, registerType } from '#comp';
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
