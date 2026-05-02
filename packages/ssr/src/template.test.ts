import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtmlShell, escape, escapeAttr, escapeJson, escapeUrl } from './template';

describe('escape', () => {
  it('blocks script-injection in element text', () => {
    assert.equal(escape('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  });

  it('escapes &, <, >, ", \'', () => {
    assert.equal(escape(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('escapeUrl', () => {
  it('passes https:// URLs', () => {
    assert.equal(escapeUrl('https://example.com/x'), 'https://example.com/x');
  });

  it('passes root-relative URLs', () => {
    assert.equal(escapeUrl('/local/path'), '/local/path');
  });

  it('rejects javascript: URLs', () => {
    assert.equal(escapeUrl('javascript:alert(1)'), '');
  });

  it('rejects data: URLs', () => {
    assert.equal(escapeUrl('data:text/html,<script>'), '');
  });

  it('rejects relative URLs (no scheme)', () => {
    // Relative paths like 'foo/bar' are ambiguous and could be misinterpreted.
    assert.equal(escapeUrl('foo/bar'), '');
  });

  it('treats null/undefined/empty as empty', () => {
    assert.equal(escapeUrl(null), '');
    assert.equal(escapeUrl(undefined), '');
    assert.equal(escapeUrl(''), '');
  });
});

describe('escapeJson', () => {
  it('escapes </script> close', () => {
    const out = escapeJson({ x: '</script><script>alert(1)//' });
    assert.ok(!out.includes('</script>'), out);
    assert.ok(out.includes('<\\/script>'));
  });

  it('escapes U+2028 / U+2029 (JSON-allows but JS-rejects)', () => {
    const out = escapeJson({ x: '\u2028\u2029' });
    assert.ok(out.includes('\\u2028'));
    assert.ok(out.includes('\\u2029'));
  });
});

describe('buildHtmlShell', () => {
  it('emits a complete static-mode shell with title', () => {
    const html = buildHtmlShell({
      html: '<h1>Hi</h1>',
      css: '.x { color: red; }',
      seo: { $type: 't.seo', title: 'Hello' } as any,
      mode: 'static',
      tailwindRuntime: false,
      isPreview: false,
    });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<title>Hello</title>'));
    assert.ok(html.includes('<h1>Hi</h1>'));
    assert.ok(html.includes('data-treenix-mode="static"'));
    // Static mode: no hydrate script + no initial JSON.
    assert.ok(!html.includes('treenix-initial'));
    assert.ok(!html.includes('@tailwindcss/browser'));
  });

  it('inlines initial JSON + hydrate script when mode=hydrate', () => {
    const html = buildHtmlShell({
      html: '<p />',
      css: '',
      seo: { $type: 't.seo', title: 'X' } as any,
      mode: 'hydrate',
      initialState: { foo: 1 },
      tailwindRuntime: false,
      isPreview: false,
      hydrateScriptUrl: '/assets/entry-hydrate.js',
    });
    assert.ok(html.includes('data-treenix-mode="hydrate"'));
    assert.ok(html.includes('<script type="application/json" id="treenix-initial">{"foo":1}</script>'));
    assert.ok(html.includes('<script type="module" src="/assets/entry-hydrate.js"></script>'));
  });

  it('forces noindex + shows preview banner when isPreview=true', () => {
    const html = buildHtmlShell({
      html: '',
      css: '',
      seo: { $type: 't.seo', title: 'T', robots: 'index,follow' } as any,
      mode: 'static',
      tailwindRuntime: false,
      isPreview: true,
    });
    assert.ok(html.includes('content="noindex,nofollow"'));
    assert.ok(!html.includes('content="index,follow"'));
    assert.ok(html.includes('data-treenix-preview'));
  });

  it('rejects script-injection in title (XSS)', () => {
    const html = buildHtmlShell({
      html: '',
      css: '',
      seo: { $type: 't.seo', title: '</title><script>alert(1)</script>' } as any,
      mode: 'static',
      tailwindRuntime: false,
      isPreview: false,
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('rejects javascript: URL in canonical (XSS)', () => {
    const html = buildHtmlShell({
      html: '',
      css: '',
      seo: { $type: 't.seo', title: 'X', canonical: 'javascript:alert(1)' } as any,
      mode: 'static',
      tailwindRuntime: false,
      isPreview: false,
    });
    assert.ok(!html.includes('javascript:'));
  });
});

// Trivial-but-exists pings to mark escapeAttr as covered.
describe('escapeAttr (alias of escape)', () => {
  it('escapes the same set as escape', () => {
    assert.equal(escapeAttr('<>"\''), escape('<>"\''));
  });
});
