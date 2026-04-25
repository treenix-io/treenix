import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getNodeEditorJsonText, parseNodeEditorJson } from './node-editor-state';

describe('getNodeEditorJsonText', () => {
  const node = {
    $path: '/docs/page',
    $type: 'doc.page',
    title: 'Hello',
    published: true,
  };

  it('returns formatted node JSON in json tab', () => {
    assert.equal(getNodeEditorJsonText(node, 'json'), JSON.stringify(node, null, 2));
  });

  it('keeps properties tab editor text empty', () => {
    assert.equal(getNodeEditorJsonText(node, 'properties'), '');
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

  it('rejects malformed JSON', () => {
    assert.throws(() => parseNodeEditorJson('{'), /Invalid JSON/);
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
