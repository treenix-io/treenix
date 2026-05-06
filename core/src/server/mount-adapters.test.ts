import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeUrlForLog } from './mount-adapters';

describe('R4-MOUNT-2 — safeUrlForLog scrubs credentials', () => {
  it('strips userinfo (basic auth)', () => {
    assert.equal(safeUrlForLog('https://user:secret@api.example.com/v1/x'), 'https://api.example.com/v1/x');
  });

  it('strips bearer-style userinfo', () => {
    const out = safeUrlForLog('https://VERY_SECRET_TOKEN@api.example.com/v1/x');
    assert.ok(!out.includes('VERY_SECRET_TOKEN'), `token leaked: ${out}`);
    assert.ok(out.includes('api.example.com'), `host missing: ${out}`);
  });

  it('strips querystring (which may contain tokens)', () => {
    const out = safeUrlForLog('https://api.example.com/x?token=SECRET&other=1');
    assert.ok(!out.includes('SECRET'), `query token leaked: ${out}`);
  });

  it('handles invalid URL safely', () => {
    assert.equal(safeUrlForLog('not-a-url'), '<invalid-url>');
  });

  it('preserves protocol/host/path for diagnostics', () => {
    assert.equal(safeUrlForLog('https://api.example.com:8443/v1/foo'), 'https://api.example.com:8443/v1/foo');
  });
});
