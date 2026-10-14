import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { minimd } from './minimd';

describe('minimd link sanitization', () => {
  // ── Allowed links ──
  it('allows https links', () => {
    const html = minimd('[click](https://example.com)');
    assert.ok(html.includes('href="https://example.com"'));
    assert.ok(html.includes('>click</a>'));
  });

  it('allows http links', () => {
    const html = minimd('[click](http://example.com)');
    assert.ok(html.includes('href="http://example.com"'));
  });

  it('allows mailto links', () => {
    const html = minimd('[email](mailto:a@b.com)');
    assert.ok(html.includes('href="mailto:a@b.com"'));
  });

  it('allows relative paths', () => {
    const html = minimd('[home](/t/demo)');
    assert.ok(html.includes('href="/t/demo"'));
  });

  it('allows anchor links', () => {
    const html = minimd('[top](#top)');
    assert.ok(html.includes('href="#top"'));
  });

  // ── Blocked schemes ──
  it('blocks javascript: URIs', () => {
    const html = minimd('[xss](javascript:alert(1))');
    assert.ok(!html.includes('href'));
    assert.ok(html.includes('xss'));
  });

  it('blocks JavaScript: case-insensitive', () => {
    const html = minimd('[xss](JavaScript:alert(1))');
    assert.ok(!html.includes('href'));
    assert.ok(html.includes('xss'));
  });

  it('blocks data: URIs', () => {
    const html = minimd('[xss](data:text/html,<script>alert(1)</script>)');
    assert.ok(!html.includes('href'));
  });

  it('blocks vbscript: URIs', () => {
    const html = minimd('[xss](vbscript:MsgBox)');
    assert.ok(!html.includes('href'));
  });

  it('blocks blob: URIs', () => {
    const html = minimd('[xss](blob:http://evil.com/uuid)');
    assert.ok(!html.includes('href'));
  });

  it('blocks file: URIs', () => {
    const html = minimd('[xss](file:///etc/passwd)');
    assert.ok(!html.includes('href'));
  });

  // ── Attribute breakout ──
  it('escapes double quotes in URLs to prevent attribute breakout', () => {
    const html = minimd('[click](https://ok.com" onclick="alert(1))');
    // " must be escaped to &quot; — no unescaped quote can break out of href="..."
    assert.ok(html.includes('&quot;'));
    // onclick appears as text within href value, NOT as a separate HTML attribute
    assert.ok(!html.includes('" onclick='));
  });

  it('handles single quotes in URLs safely', () => {
    const html = minimd("[click](https://ok.com' onclick='alert(1))");
    // href uses double quotes, so single quotes inside are safe — no breakout
    assert.ok(html.includes("href=\"https://ok.com'"));
    // But verify no attribute injection occurred
    
    // The onclick is inside the href value, not a separate attribute
    assert.ok(!html.includes('" onclick='));
  });

  // ── Markdown features regression ──
  it('normal markdown features still work', () => {
    const html = minimd('**bold** and `code` and _italic_');
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<code>code</code>'));
    assert.ok(html.includes('<em>italic</em>'));
  });

  it('renders lists correctly', () => {
    const html = minimd('- item one\n- item two');
    assert.ok(html.includes('<ul>'));
    assert.ok(html.includes('<li>item one</li>'));
    assert.ok(html.includes('<li>item two</li>'));
  });
});
