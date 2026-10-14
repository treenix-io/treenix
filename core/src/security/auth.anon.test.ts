import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANON_COOKIE_MAX_AGE, SESSION_COOKIE_MAX_AGE, buildSessionCookie } from './cookies';

describe('cookie Max-Age separation', () => {
  it('default user cookie uses SESSION_TTL', () => {
    const cookie = buildSessionCookie('user-token');
    // Default param is in seconds — match against the cookie lifetime
    assert.match(cookie, new RegExp(`Max-Age=${SESSION_COOKIE_MAX_AGE}\\b`));
  });

  it('anon cookie uses 1-year Max-Age (decoupled from user TTL)', () => {
    const cookie = buildSessionCookie('anon.token', ANON_COOKIE_MAX_AGE);
    assert.match(cookie, /Max-Age=31536000\b/, 'anon Max-Age = 365 days');
    assert.doesNotMatch(
      cookie,
      new RegExp(`Max-Age=${SESSION_COOKIE_MAX_AGE}\\b`),
      'anon does NOT leak user TTL',
    );
  });
});
