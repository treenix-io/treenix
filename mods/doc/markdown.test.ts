import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mdToTiptap, resolveLinkPath, type TiptapNode, tiptapToMd } from './markdown';

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

  // Regression: ProseMirror rejects { type: 'text', text: '' } with
  // "RangeError: Empty text nodes are not allowed", which kills the editor
  // when DocPageView tries to setContent on a doc that contains them.
  it('never produces empty text nodes', () => {
    const samples = [
      '',
      '# ',
      '## \n\nbody',
      '\n\n\n',
      '> \n> ',
      '- \n- item',
    ];
    for (const md of samples) {
      const doc = mdToTiptap(md);
      const stack: TiptapNode[] = [doc];
      while (stack.length) {
        const n = stack.pop()!;
        if (n.type === 'text') assert.ok(n.text && n.text.length > 0, `empty text node from input: ${JSON.stringify(md)}`);
        if (n.content) stack.push(...n.content);
      }
    }
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

describe('resolveLinkPath', () => {
  it('returns null for external URLs', () => {
    assert.equal(resolveLinkPath('https://x.com'), null);
    assert.equal(resolveLinkPath('http://x.com', '/docs/a.md'), null);
    assert.equal(resolveLinkPath('mailto:a@b.c'), null);
  });

  it('returns null for fragment-only', () => {
    assert.equal(resolveLinkPath('#section', '/docs/a.md'), null);
  });

  it('strips treenix: scheme', () => {
    assert.equal(resolveLinkPath('treenix:/foo/bar'), '/foo/bar');
  });

  it('returns absolute paths as-is', () => {
    assert.equal(resolveLinkPath('/abs/path.md'), '/abs/path.md');
  });

  it('resolves ./ relative against parent of basePath', () => {
    assert.equal(
      resolveLinkPath('./concepts/types.md', '/docs/public/index.md'),
      '/docs/public/concepts/types.md',
    );
  });

  it('resolves ../ relative against grandparent', () => {
    assert.equal(
      resolveLinkPath('../sibling.md', '/docs/public/index.md'),
      '/docs/sibling.md',
    );
  });

  it('resolves bare relative as ./ relative', () => {
    assert.equal(
      resolveLinkPath('foo.md', '/docs/index.md'),
      '/docs/foo.md',
    );
  });

  it('strips query and fragment from href', () => {
    assert.equal(
      resolveLinkPath('./x.md?v=1#anchor', '/docs/a.md'),
      '/docs/x.md',
    );
  });

  it('returns null for relative without basePath', () => {
    assert.equal(resolveLinkPath('./x.md'), null);
  });
});

describe('mdToTiptap link parsing', () => {
  it('parses [text](relative.md) as nodeLink', () => {
    const doc = mdToTiptap('See [Types](./concepts/types.md).', '/docs/public/index.md');
    const para = doc.content?.[0];
    const linkNode = para?.content?.find((n) => n.marks?.[0]?.type === 'nodeLink');
    assert.ok(linkNode, 'expected a nodeLink');
    assert.equal(linkNode!.text, 'Types');
    assert.equal(linkNode!.marks![0].attrs?.path, '/docs/public/concepts/types.md');
  });

  it('parses [text](treenix:/path) as nodeLink', () => {
    const doc = mdToTiptap('go [home](treenix:/foo)');
    const link = doc.content?.[0].content?.find((n) => n.marks?.[0]?.type === 'nodeLink');
    assert.ok(link);
    assert.equal(link!.marks![0].attrs?.path, '/foo');
  });

  it('keeps external link as plain text', () => {
    const doc = mdToTiptap('see [docs](https://example.com)');
    const para = doc.content?.[0];
    const hasNodeLink = para?.content?.some((n) => n.marks?.[0]?.type === 'nodeLink');
    assert.equal(hasNodeLink, false);
    const text = para?.content?.map((n) => n.text).join('') ?? '';
    assert.ok(text.includes('docs'));
  });

  it('keeps relative link without basePath as plain text', () => {
    const doc = mdToTiptap('see [Types](./types.md)');
    const para = doc.content?.[0];
    const hasNodeLink = para?.content?.some((n) => n.marks?.[0]?.type === 'nodeLink');
    assert.equal(hasNodeLink, false);
  });

  // Regression: bold/italic wrapping a link must still parse the link inside,
  // not treat the whole markdown source as bold text. Common in lists like
  // "- **[Storage](./types.md)** — every instance persists".
  it('parses link nested inside bold', () => {
    const doc = mdToTiptap('- **[Storage](./types.md#storage)** — note', '/docs/index.md');
    const para = doc.content?.[0]?.content?.[0]?.content?.[0]; // bulletList → listItem → paragraph
    const linkNode = para?.content?.find((n) =>
      n.marks?.some((m) => m.type === 'nodeLink'),
    );
    assert.ok(linkNode, 'expected a link inside bold');
    assert.equal(linkNode!.text, 'Storage');
    const markTypes = (linkNode!.marks ?? []).map((m) => m.type).sort();
    assert.deepEqual(markTypes, ['bold', 'nodeLink']);
    const linkMark = linkNode!.marks!.find((m) => m.type === 'nodeLink');
    assert.equal(linkMark?.attrs?.path, '/docs/types.md');
  });

  it('parses link nested inside italic', () => {
    const doc = mdToTiptap('see *[Types](./types.md)* here', '/docs/index.md');
    const linkNode = doc.content?.[0]?.content?.find((n) =>
      n.marks?.some((m) => m.type === 'nodeLink'),
    );
    assert.ok(linkNode);
    const markTypes = (linkNode!.marks ?? []).map((m) => m.type).sort();
    assert.deepEqual(markTypes, ['italic', 'nodeLink']);
  });

  it('parses bold marker inside link text', () => {
    const doc = mdToTiptap('see [**bold link**](./types.md) here', '/docs/index.md');
    const para = doc.content?.[0];
    const boldLink = para?.content?.find((n) =>
      n.marks?.some((m) => m.type === 'bold') &&
      n.marks?.some((m) => m.type === 'nodeLink'),
    );
    assert.ok(boldLink, 'link text should preserve bold mark');
    assert.equal(boldLink!.text, 'bold link');
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

describe('nodeLink href preservation', () => {
  // Regression: codec used to rewrite `./types.md` → `treenix:/abs/path` on roundtrip.
  // Treenix scheme breaks plain markdown viewers (GitHub, VS Code preview); relative
  // form is the authorial contract. We now store the original href on the mark and
  // re-emit it as long as it still resolves to the same absolute path.
  it('preserves relative href through full roundtrip', () => {
    const original = 'See [Types](./concepts/types.md).';
    const basePath = '/docs/public/index.md';
    const tiptap = mdToTiptap(original, basePath);
    const result = tiptapToMd(tiptap, basePath);
    assert.ok(result.includes('[Types](./concepts/types.md)'), `expected relative href preserved, got: ${result}`);
    assert.ok(!result.includes('treenix:'), 'treenix: scheme must not appear in encoded output');
  });

  it('drops legacy treenix: scheme and emits absolute path', () => {
    // Old documents on disk may contain `[T](treenix:/a)`; we decode them but never
    // round-trip the scheme back out — encoders write standard markdown only.
    const tiptap = mdToTiptap('go [home](treenix:/foo)');
    const result = tiptapToMd(tiptap);
    assert.ok(result.includes('[home](/foo)'), `expected legacy scheme stripped, got: ${result}`);
    assert.ok(!result.includes('treenix:'));
  });

  it('emits absolute path when no sourceHref is stored (programmatic links)', () => {
    // Slash-menu / [[/path]] input rule produce nodeLinks without an authored href.
    // Encode falls back to the absolute path — still valid markdown, no `treenix:`.
    const tiptap: TiptapNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'See it', marks: [{ type: 'nodeLink', attrs: { path: '/notes/x' } }] }],
      }],
    };
    const result = tiptapToMd(tiptap);
    assert.ok(result.includes('[See it](/notes/x)'));
    assert.ok(!result.includes('treenix:'));
  });

  it('falls back to absolute path when sourceHref no longer resolves to path (stale link)', () => {
    // Simulates a retargeted link: stored path no longer matches what sourceHref
    // would resolve to. We MUST NOT emit the stale href.
    const tiptap: TiptapNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'X', marks: [{ type: 'nodeLink', attrs: { path: '/docs/new.md', sourceHref: './old.md' } }] }],
      }],
    };
    const result = tiptapToMd(tiptap, '/docs/index.md');
    assert.ok(result.includes('[X](/docs/new.md)'), `expected absolute fallback, got: ${result}`);
    assert.ok(!result.includes('./old.md'));
  });

  it('preserves href with query and fragment', () => {
    const original = 'see [t](./x.md?v=1#anchor)';
    const basePath = '/docs/a.md';
    const tiptap = mdToTiptap(original, basePath);
    const result = tiptapToMd(tiptap, basePath);
    assert.ok(result.includes('[t](./x.md?v=1#anchor)'), `expected query+fragment preserved, got: ${result}`);
  });
});

describe('treenix fenced embed', () => {
  // Regression: treenixBlock used to serialize as lossy `[Component: foo at /bar]` text
  // that mdToTiptap could not parse back. Roundtrip destroyed the embed. The structured
  // fenced format makes embeds first-class while staying valid markdown.
  it('roundtrips a component embed with $ref/$type/$context/$props', () => {
    const original = [
      '```treenix',
      '$type: chart.bar',
      '$ref: /data/sales',
      '$context: react:compact',
      '$props:',
      '  height: 200',
      '  label: Sales',
      '```',
    ].join('\n');
    const tiptap = mdToTiptap(original);
    const block = tiptap.content?.[0];
    assert.equal(block?.type, 'treenixBlock');
    assert.equal(block?.attrs?.type, 'chart.bar');
    assert.equal(block?.attrs?.ref, '/data/sales');
    assert.equal(block?.attrs?.context, 'react:compact');
    assert.deepEqual(block?.attrs?.props, { height: 200, label: 'Sales' });

    const result = tiptapToMd(tiptap);
    const re = mdToTiptap(result);
    // Roundtrip must produce identical attrs — the embed survives byte-equivalent on the wire.
    assert.deepEqual(re.content?.[0]?.attrs, block?.attrs);
  });

  it('roundtrips a query embed with $where filters', () => {
    const original = [
      '```treenix',
      '$query: /todos',
      '$type: todo.item',
      '$where:',
      '  done: false',
      '  priority: high',
      '```',
    ].join('\n');
    const tiptap = mdToTiptap(original);
    const block = tiptap.content?.[0];
    assert.equal(block?.type, 'queryBlock');
    assert.equal(block?.attrs?.path, '/todos');
    assert.equal(block?.attrs?.type, 'todo.item');
    // $where keys/values land as { field, value: String(v) } — matches queryBlock attr shape.
    assert.deepEqual(block?.attrs?.filters, [
      { field: 'done', value: 'false' },
      { field: 'priority', value: 'high' },
    ]);

    const result = tiptapToMd(tiptap);
    const re = mdToTiptap(result);
    assert.deepEqual(re.content?.[0]?.attrs?.filters, block?.attrs?.filters);
    assert.equal(re.content?.[0]?.attrs?.path, '/todos');
  });

  it('falls back to plain codeBlock on malformed embed YAML — body verbatim', () => {
    // Defensive contract: a broken embed must NEVER crash decode. We keep the body
    // intact in a codeBlock so the user can fix it in their editor.
    const original = '```treenix\nthis is: : : not yaml\n  random indent\n```';
    const tiptap = mdToTiptap(original);
    const block = tiptap.content?.[0];
    assert.equal(block?.type, 'codeBlock', 'malformed embed must fall back to codeBlock');
    assert.equal(block?.attrs?.language, 'treenix');
    const text = block?.content?.[0]?.text ?? '';
    assert.ok(text.includes('this is: : : not yaml'));
  });

  it('falls back to plain codeBlock when $query and $ref both present (conflict)', () => {
    // Ambiguous embed — refuse silent coercion. Body is preserved verbatim so the
    // author sees exactly what they wrote and can resolve the conflict.
    const original = '```treenix\n$query: /todos\n$ref: /data/sales\n```';
    const tiptap = mdToTiptap(original);
    const block = tiptap.content?.[0];
    assert.equal(block?.type, 'codeBlock');
    assert.equal(block?.attrs?.language, 'treenix');
  });

  it('falls back to plain codeBlock when no embed-shaped fields are present', () => {
    // Random YAML in a `treenix` fence is not an embed. Treat as a codeBlock so the
    // user's content survives unchanged through a roundtrip.
    const original = '```treenix\njust: a config\n```';
    const tiptap = mdToTiptap(original);
    const block = tiptap.content?.[0];
    assert.equal(block?.type, 'codeBlock');
  });

  it('roundtrips a component embed with nested $props', () => {
    // Mini-YAML supports recursive block mappings — nested objects in props survive
    // a full encode/decode cycle.
    const tiptap: TiptapNode = {
      type: 'doc',
      content: [{
        type: 'treenixBlock',
        attrs: {
          type: 'chart.area',
          ref: null,
          context: 'react',
          props: { style: { color: 'red', size: 12 }, height: 200 },
        },
      }],
    };
    const md = tiptapToMd(tiptap);
    const re = mdToTiptap(md);
    assert.deepEqual(re.content?.[0]?.attrs?.props, { style: { color: 'red', size: 12 }, height: 200 });
  });

  it('emits no $context line when context is the default react', () => {
    // Defaults stay implicit — keeps the wire format compact and the diff minimal.
    const tiptap: TiptapNode = {
      type: 'doc',
      content: [{
        type: 'treenixBlock',
        attrs: { type: 'x.y', ref: null, props: {}, context: 'react' },
      }],
    };
    const md = tiptapToMd(tiptap);
    assert.ok(!md.includes('$context'), `default context should be implicit, got: ${md}`);
  });
});
