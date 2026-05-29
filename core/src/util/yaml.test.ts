import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emitYaml, parseYaml, type YamlValue } from './yaml';

describe('parseYaml — scalars', () => {
  it('empty input → empty object', () => {
    assert.deepEqual(parseYaml(''), {});
    assert.deepEqual(parseYaml('\n\n'), {});
  });

  it('parses null forms', () => {
    assert.deepEqual(parseYaml('a: null\nb: ~\nc: Null'), { a: null, b: null, c: null });
  });

  it('parses booleans', () => {
    assert.deepEqual(parseYaml('a: true\nb: false\nc: True'), { a: true, b: false, c: true });
  });

  it('parses numbers', () => {
    assert.deepEqual(parseYaml('i: 42\nf: 3.14\nn: -5\ne: 1e3'), { i: 42, f: 3.14, n: -5, e: 1000 });
  });

  it('parses bare strings', () => {
    assert.deepEqual(parseYaml('s: hello world'), { s: 'hello world' });
  });

  it('parses quoted strings — preserves leading colons and special chars', () => {
    assert.deepEqual(
      parseYaml('a: "hello: world"\nb: \'it\\\'s ok\''),
      { a: 'hello: world', b: "it's ok" },
    );
  });

  it('value containing colon-not-followed-by-space stays in value', () => {
    // "url: https://example.com" — the colon after "https" is part of the value.
    assert.deepEqual(parseYaml('url: https://example.com'), { url: 'https://example.com' });
  });
});

describe('parseYaml — arrays', () => {
  it('flow array of strings', () => {
    assert.deepEqual(parseYaml('tags: [intro, overview, api]'), { tags: ['intro', 'overview', 'api'] });
  });

  it('flow array empty', () => {
    assert.deepEqual(parseYaml('tags: []'), { tags: [] });
  });

  it('flow array with quoted entries', () => {
    assert.deepEqual(parseYaml('items: ["a, b", c]'), { items: ['a, b', 'c'] });
  });

  it('flow array of mixed types', () => {
    assert.deepEqual(parseYaml('mixed: [1, true, null, "x"]'), { mixed: [1, true, null, 'x'] });
  });

  it('block array', () => {
    const r = parseYaml('items:\n  - one\n  - two\n  - three');
    assert.deepEqual(r, { items: ['one', 'two', 'three'] });
  });

  it('block array with mixed scalars', () => {
    const r = parseYaml('vals:\n  - 1\n  - true\n  - hello');
    assert.deepEqual(r, { vals: [1, true, 'hello'] });
  });
});

describe('parseYaml — comments', () => {
  it('strips full-line and trailing comments', () => {
    const r = parseYaml('# header\na: 1 # inline\nb: 2');
    assert.deepEqual(r, { a: 1, b: 2 });
  });

  it('does not strip # inside quoted strings', () => {
    assert.deepEqual(parseYaml('a: "not # a comment"'), { a: 'not # a comment' });
  });
});

describe('parseYaml — frontmatter shape', () => {
  it('parses a real-world doc frontmatter', () => {
    const yaml = `title: Introduction
section: root
order: 0
description: An AI-native platform where things compose
tags: [intro, overview]`;
    assert.deepEqual(parseYaml(yaml), {
      title: 'Introduction',
      section: 'root',
      order: 0,
      description: 'An AI-native platform where things compose',
      tags: ['intro', 'overview'],
    });
  });
});

describe('parseYaml — error cases', () => {
  it('throws on missing colon in mapping line', () => {
    assert.throws(() => parseYaml('not a key value pair'));
  });

  it('throws on inconsistent indent in mapping', () => {
    assert.throws(() => parseYaml('a: 1\n  b: 2'));
  });
});

describe('parseYaml — arrays of mappings (C16)', () => {
  it('parses inline "- key: value" items, with continuation lines', () => {
    const r = parseYaml('authors:\n  - name: a\n    age: 1\n  - name: b');
    assert.deepEqual(r, { authors: [{ name: 'a', age: 1 }, { name: 'b' }] });
  });
});

describe('parseYaml — empty flow mapping (C39)', () => {
  it('reads a bare empty mapping', () => {
    assert.deepEqual(parseYaml('{}'), {});
  });

  it('reads a nested empty mapping', () => {
    assert.deepEqual(parseYaml('props:\n  {}'), { props: {} });
  });
});

describe('emit ↔ parse roundtrip', () => {
  const rt = (v: YamlValue) => parseYaml(emitYaml(v));

  it('roundtrips a multiline / tabbed string (C17)', () => {
    const v = { description: 'line1\nline2\twith tab' };
    assert.deepEqual(rt(v), v);
  });

  it('roundtrips an empty object, nested and top-level (C39)', () => {
    assert.deepEqual(rt({}), {});
    assert.deepEqual(rt({ props: {} }), { props: {} });
  });
});
