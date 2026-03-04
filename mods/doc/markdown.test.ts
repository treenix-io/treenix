import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mdToTiptap, type TiptapNode, tiptapToMd } from './markdown';

describe('mdToTiptap', () => {
  it('parses heading', () => {
    const doc = mdToTiptap('# Hello');
    assert.equal(doc.type, 'doc');
    assert.equal(doc.content?.[0].type, 'heading');
    assert.equal(doc.content?.[0].attrs?.level, 1);
    assert.equal(doc.content?.[0].content?.[0].text, 'Hello');
  });

  it('parses multiple heading levels', () => {
    const doc = mdToTiptap('## Second\n### Third');
    assert.equal(doc.content?.[0].attrs?.level, 2);
    assert.equal(doc.content?.[1].attrs?.level, 3);
  });

  it('parses paragraph', () => {
    const doc = mdToTiptap('Just some text');
    assert.equal(doc.content?.[0].type, 'paragraph');
    assert.equal(doc.content?.[0].content?.[0].text, 'Just some text');
  });

  it('parses bold and italic', () => {
    const doc = mdToTiptap('This is **bold** and *italic*');
    const nodes = doc.content?.[0].content ?? [];
    assert.ok(nodes.some((n) => n.text === 'bold' && n.marks?.[0]?.type === 'bold'));
    assert.ok(nodes.some((n) => n.text === 'italic' && n.marks?.[0]?.type === 'italic'));
  });

  it('parses inline code', () => {
    const doc = mdToTiptap('Use `foo()` here');
    const nodes = doc.content?.[0].content ?? [];
    assert.ok(nodes.some((n) => n.text === 'foo()' && n.marks?.[0]?.type === 'code'));
  });

  it('parses bullet list', () => {
    const doc = mdToTiptap('- one\n- two\n- three');
    assert.equal(doc.content?.[0].type, 'bulletList');
    assert.equal(doc.content?.[0].content?.length, 3);
  });

  it('parses ordered list', () => {
    const doc = mdToTiptap('1. first\n2. second');
    assert.equal(doc.content?.[0].type, 'orderedList');
    assert.equal(doc.content?.[0].content?.length, 2);
  });

  it('parses code block', () => {
    const doc = mdToTiptap('```ts\nconst x = 1;\n```');
    assert.equal(doc.content?.[0].type, 'codeBlock');
    assert.equal(doc.content?.[0].attrs?.language, 'ts');
    assert.equal(doc.content?.[0].content?.[0].text, 'const x = 1;');
  });

  it('parses blockquote', () => {
    const doc = mdToTiptap('> quoted text');
    assert.equal(doc.content?.[0].type, 'blockquote');
  });

  it('parses horizontal rule', () => {
    const doc = mdToTiptap('---');
    assert.equal(doc.content?.[0].type, 'horizontalRule');
  });

  it('handles empty input', () => {
    const doc = mdToTiptap('');
    assert.equal(doc.type, 'doc');
    assert.ok(doc.content?.length);
  });

  it('handles mixed content', () => {
    const md = '# Title\n\nSome text\n\n- item 1\n- item 2\n\n```\ncode\n```';
    const doc = mdToTiptap(md);
    const types = doc.content?.map((c) => c.type);
    assert.deepEqual(types, ['heading', 'paragraph', 'bulletList', 'codeBlock']);
  });
});

describe('tiptapToMd', () => {
  it('converts heading', () => {
    const doc: TiptapNode = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] }],
    };
    assert.equal(tiptapToMd(doc), '## Title');
  });

  it('converts paragraph with marks', () => {
    const doc: TiptapNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
        ],
      }],
    };
    assert.equal(tiptapToMd(doc), 'Hello **world**');
  });

  it('converts bullet list', () => {
    const doc: TiptapNode = {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
        ],
      }],
    };
    assert.equal(tiptapToMd(doc), '- a\n- b');
  });

  it('converts code block', () => {
    const doc: TiptapNode = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x = 1' }] }],
    };
    assert.equal(tiptapToMd(doc), '```js\nx = 1\n```');
  });

  it('converts horizontal rule', () => {
    const doc: TiptapNode = { type: 'doc', content: [{ type: 'horizontalRule' }] };
    assert.equal(tiptapToMd(doc), '---');
  });
});

describe('roundtrip md → tiptap → md', () => {
  it('preserves basic structure', () => {
    const original = '# Hello\n\nSome paragraph\n\n- one\n- two';
    const tiptap = mdToTiptap(original);
    const result = tiptapToMd(tiptap);
    // Should contain the same elements (whitespace may differ)
    assert.ok(result.includes('# Hello'));
    assert.ok(result.includes('Some paragraph'));
    assert.ok(result.includes('- one'));
    assert.ok(result.includes('- two'));
  });

  it('preserves code block', () => {
    const original = '```ts\nconst x = 1;\n```';
    const tiptap = mdToTiptap(original);
    const result = tiptapToMd(tiptap);
    assert.ok(result.includes('```ts'));
    assert.ok(result.includes('const x = 1;'));
  });
});
