import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeHref } from './sanitize-href';

describe('sanitizeHref', () => {
  // ── Allowed protocols ──
  it('allows https', () =>
    assert.equal(sanitizeHref('https://example.com'), 'https://example.com'));
  it('allows http', () => assert.equal(sanitizeHref('http://example.com'), 'http://example.com'));
  it('allows mailto', () => assert.equal(sanitizeHref('mailto:a@b.com'), 'mailto:a@b.com'));
  it('allows tel', () => assert.equal(sanitizeHref('tel:+1234'), 'tel:+1234'));
  it('allows relative path', () => assert.equal(sanitizeHref('/t/demo'), '/t/demo'));
  it('allows anchor', () => assert.equal(sanitizeHref('#section'), '#section'));

  // ── Blocked schemes ──
  it('blocks javascript:', () => assert.equal(sanitizeHref('javascript:alert(1)'), null));
  it('blocks JAVASCRIPT: (case insensitive)', () =>
    assert.equal(sanitizeHref('JAVASCRIPT:alert(1)'), null));
  it('blocks data:', () =>
    assert.equal(sanitizeHref('data:text/html,<script>alert(1)</script>'), null));
  it('blocks vbscript:', () => assert.equal(sanitizeHref('vbscript:MsgBox'), null));
  it('blocks blob:', () => assert.equal(sanitizeHref('blob:http://evil.com/uuid'), null));
  it('blocks file:', () => assert.equal(sanitizeHref('file:///etc/passwd'), null));

  // ── Bypass attempts ──
  it('blocks java\\tscript: with tab', () =>
    assert.equal(sanitizeHref('java\tscript:alert(1)'), null));
  it('blocks java\\nscript: with newline', () =>
    assert.equal(sanitizeHref('java\nscript:alert(1)'), null));
  it('blocks leading space + javascript:', () =>
    assert.equal(sanitizeHref(' javascript:alert(1)'), null));
  it('blocks null byte prefix', () => assert.equal(sanitizeHref('\0javascript:alert(1)'), null));

  // ── Edge cases ──
  it('returns null for empty string', () => assert.equal(sanitizeHref(''), null));
  it('returns null for whitespace only', () => assert.equal(sanitizeHref('   '), null));
});
