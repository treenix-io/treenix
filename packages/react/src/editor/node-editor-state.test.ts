import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NodeData } from '@treenx/core';
import { getNodeEditorJsonText, parseNodeEditorJson, saveNodeEditorJson } from './node-editor-state';

describe('getNodeEditorJsonText', () => {
  it('returns the node serialized as pretty JSON', () => {
    const node = {
      $path: '/docs/page',
      $type: 'doc.page',
      title: 'Hello',
      published: true,
    };

    assert.equal(getNodeEditorJsonText(node), JSON.stringify(node, null, 2));
  });
});

describe('parseNodeEditorJson', () => {
  it('parses a full node object', () => {
    const node = parseNodeEditorJson(JSON.stringify({
      $path: '/docs/page',
      $type: 'doc.page',
      title: 'Hello',
    }));

    assert.equal(node.$path, '/docs/page');
    assert.equal(node.$type, 'doc.page');
    assert.equal(node.title, 'Hello');
  });

  it('keeps the underlying parser message on malformed JSON', () => {
    assert.throws(() => parseNodeEditorJson('{'), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^Invalid JSON: /);
      // Original parser message is preserved after the prefix
      assert.ok(err.message.length > 'Invalid JSON: '.length);
      return true;
    });
  });

  it('rejects non-object JSON', () => {
    assert.throws(() => parseNodeEditorJson('[]'), /JSON must be a node object/);
  });

  it('rejects objects without $path', () => {
    assert.throws(() => parseNodeEditorJson(JSON.stringify({ $type: 'doc.page' })), /\$path/);
  });

  it('rejects objects without $type', () => {
    assert.throws(() => parseNodeEditorJson(JSON.stringify({ $path: '/docs/page' })), /\$type/);
  });
});

describe('saveNodeEditorJson', () => {
  // Fake set that mimics tree.set OCC: rejects stale $rev, returns persisted node with bumped $rev
  function makeFakeSet(initialRev: number) {
    let serverRev = initialRev;
    const setFn = async (node: NodeData): Promise<NodeData> => {
      if (node.$rev !== serverRev) {
        const err = new Error('CONFLICT') as Error & { code: string };
        err.code = 'CONFLICT';
        throw err;
      }
      serverRev += 1;
      return { ...node, $rev: serverRev };
    };
    return { setFn, getRev: () => serverRev };
  }

  it('returns text with the bumped $rev from the fresh node', async () => {
    const { setFn } = makeFakeSet(1);
    const initial = JSON.stringify({ $path: '/docs2', $type: 't', n: 1, $rev: 1 }, null, 2);

    const after = await saveNodeEditorJson(initial, setFn);

    assert.equal(JSON.parse(after).$rev, 2);
  });

  it('regression: two consecutive saves do not trigger OCC CONFLICT', async () => {
    const { setFn, getRev } = makeFakeSet(1);
    const initial = JSON.stringify({ $path: '/docs2', $type: 't', n: 1, $rev: 1 }, null, 2);

    // First save — uses initial $rev=1, server bumps to 2
    const afterFirst = await saveNodeEditorJson(initial, setFn);
    assert.equal(JSON.parse(afterFirst).$rev, 2);

    // User edits the saved text and saves again — must carry the fresh $rev=2
    const edited = JSON.stringify({ ...JSON.parse(afterFirst), n: 2 }, null, 2);
    const afterSecond = await saveNodeEditorJson(edited, setFn);

    assert.equal(JSON.parse(afterSecond).$rev, 3);
    assert.equal(getRev(), 3);
  });

  it('propagates set errors (e.g. CONFLICT) to caller', async () => {
    const stale = async (): Promise<NodeData> => {
      const err = new Error('CONFLICT') as Error & { code: string };
      err.code = 'CONFLICT';
      throw err;
    };
    const text = JSON.stringify({ $path: '/x', $type: 't', $rev: 1 }, null, 2);

    await assert.rejects(
      () => saveNodeEditorJson(text, stale),
      (e: unknown) => (e as { code: string }).code === 'CONFLICT',
    );
  });
});
