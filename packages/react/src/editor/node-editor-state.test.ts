import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getNodeEditorJsonText, parseNodeEditorJson } from './node-editor-state';

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
