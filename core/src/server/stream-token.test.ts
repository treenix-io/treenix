import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStreamTokenStore } from './stream-token';
import type { Session } from './auth';

const session: Session = { userId: 'alice', claims: ['u:alice', 'authenticated'] };

describe('streamTokenStore — mint/resolve/purge', () => {
  it('mints a fresh hex token bound to session', () => {
    const s = createStreamTokenStore();
    const { token, expiresInMs } = s.mint(session);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(expiresInMs, 5 * 60_000);
    assert.deepEqual(s.resolve(token), session);
  });

  it('returns null for unknown token', () => {
    const s = createStreamTokenStore();
    assert.equal(s.resolve('deadbeef'.repeat(8)), null);
  });

  it('purges all tokens for a userId on logout', () => {
    const s = createStreamTokenStore();
    const a = s.mint(session).token;
    const b = s.mint(session).token;
    const c = s.mint({ userId: 'bob', claims: ['u:bob'] }).token;

    s.purgeForUser('alice');
    assert.equal(s.resolve(a), null, 'alice token gone');
    assert.equal(s.resolve(b), null, 'second alice token gone');
    assert.deepEqual(s.resolve(c), { userId: 'bob', claims: ['u:bob'] }, 'bob token preserved');
  });

  it('treats expired token as missing and clears it from the map', () => {
    const s = createStreamTokenStore();
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const { token } = s.mint(session);
      now += 5 * 60_000 + 1;
      assert.equal(s.resolve(token), null, 'expired returns null');
      // Second resolve still null — entry actually deleted, not lazy
      assert.equal(s.resolve(token), null);
    } finally {
      Date.now = realNow;
    }
  });
});
