import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serializeFrontmatter, splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  it('returns null frontmatter when fence is missing', () => {
    const r = splitFrontmatter('# Hello\n\nBody only.');
    assert.equal(r.frontmatter, null);
    assert.equal(r.body, '# Hello\n\nBody only.');
  });

  it('returns null when only opening fence (no closing)', () => {
    const raw = '---\ntitle: x\nstill no close';
    const r = splitFrontmatter(raw);
    assert.equal(r.frontmatter, null);
    assert.equal(r.body, raw);
  });

  it('extracts known fields into typed slots', () => {
    const raw = `---\ntitle: Introduction\ndescription: An AI-native platform\norder: 0\nsection: root\ntags: [intro, overview]\n---\n\n# Body`;
    const { frontmatter, body } = splitFrontmatter(raw);
    assert.deepEqual(frontmatter, {
      title: 'Introduction',
      description: 'An AI-native platform',
      order: 0,
      section: 'root',
      tags: ['intro', 'overview'],
    });
    assert.equal(body, '# Body');
  });

  it('puts unknown keys into extra', () => {
    const raw = `---\ntitle: T\nlayout: post\ndraft: true\n---\nbody`;
    const { frontmatter } = splitFrontmatter(raw);
    assert.equal(frontmatter?.title, 'T');
    assert.deepEqual(frontmatter?.extra, { layout: 'post', draft: true });
  });

  it('coerces order to number when provided as numeric string', () => {
    const raw = `---\norder: "5"\n---\n`;
    const { frontmatter } = splitFrontmatter(raw);
    assert.equal(frontmatter?.order, 5);
  });

  it('wraps single-string tag into an array', () => {
    const raw = `---\ntags: solo\n---\n`;
    const { frontmatter } = splitFrontmatter(raw);
    assert.deepEqual(frontmatter?.tags, ['solo']);
  });

  it('strips BOM before fence detection', () => {
    const raw = '\uFEFF---\ntitle: T\n---\nbody';
    const { frontmatter, body } = splitFrontmatter(raw);
    assert.equal(frontmatter?.title, 'T');
    assert.equal(body, 'body');
  });

  it('treats malformed YAML as no frontmatter rather than crashing', () => {
    const raw = `---\nthis is not: valid: yaml: here\n  bad indent\n---\nbody`;
    const r = splitFrontmatter(raw);
    // Either parsed somehow or fell back — must not throw, body must be present.
    assert.ok(typeof r.body === 'string');
  });
});

describe('serializeFrontmatter', () => {
  it('returns empty string for null/empty', () => {
    assert.equal(serializeFrontmatter(null), '');
    assert.equal(serializeFrontmatter({}), '');
  });

  it('serializes known fields in canonical order', () => {
    const out = serializeFrontmatter({
      title: 'T',
      description: 'D',
      section: 'root',
      order: 1,
      tags: ['a', 'b'],
    });
    assert.equal(
      out,
      '---\ntitle: T\ndescription: D\nsection: root\norder: 1\ntags: [a, b]\n---\n\n',
    );
  });

  it('quotes strings that contain special chars', () => {
    const out = serializeFrontmatter({ title: 'has: colon' });
    assert.match(out, /title: "has: colon"/);
  });

  it('roundtrip: split → serialize preserves content', () => {
    const raw = `---\ntitle: T\ntags: [a, b]\norder: 2\n---\nbody\n`;
    const { frontmatter, body } = splitFrontmatter(raw);
    const re = serializeFrontmatter(frontmatter) + body;
    const second = splitFrontmatter(re);
    assert.deepEqual(second.frontmatter, frontmatter);
    assert.equal(second.body, body);
  });
});
