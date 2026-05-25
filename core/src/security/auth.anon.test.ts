// Anon session tests — closes core-t9d
//
// Verifies: signed-token round trip, tamper/expiry rejection, resolveOrIssueSession
// strict semantics (any invalid cookie → expired_session, never silent anon),
// identity persistence across requests, cookie Max-Age separation.

import { createHmac, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createMemoryTree } from '#tree';
import {
  _resetAnonKeyForTests,
  ANON_COOKIE_MAX_AGE,
  buildSessionCookie,
  createAnonSession,
  resolveOrIssueSession,
  resolveToken,
  SESSION_TTL_MS,
} from './auth';

const TEST_KEY_HEX = randomBytes(32).toString('hex');

afterEach(() => { _resetAnonKeyForTests(); delete process.env.TREENIX_ANON_KEY; });

describe('anon session — signed token', () => {

  beforeEach(() => { process.env.TREENIX_ANON_KEY = TEST_KEY_HEX; });

  it('round-trip: createAnonSession → resolveToken returns same identity', async () => {
    const tree = createMemoryTree();
    const { session, token } = await createAnonSession(tree);

    assert.match(token, /^anon\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(session.userId, /^anon:[0-9a-f]{32}$/);
    assert.deepEqual(session.claims, ['public']);
    assert.equal(session.anonymous, true);

    const resolved = await resolveToken(tree, token);
    assert.deepEqual(resolved, session, 'resolved session matches issued');
  });

  it('identity persistence: same anon cookie → same userId across resolves', async () => {
    const tree = createMemoryTree();
    const { token, session } = await createAnonSession(tree);

    const r1 = await resolveToken(tree, token);
    const r2 = await resolveToken(tree, token);

    assert.equal(r1?.userId, session.userId);
    assert.equal(r2?.userId, session.userId, 'returning visitor keeps identity');
  });

  it('tampered signature → null', async () => {
    const tree = createMemoryTree();
    const { token } = await createAnonSession(tree);

    // Flip one char in the sig
    const parts = token.split('.');
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');

    const resolved = await resolveToken(tree, tampered);
    assert.equal(resolved, null, 'tampered sig rejected');
  });

  it('wrong key → null', async () => {
    const tree = createMemoryTree();
    const { token } = await createAnonSession(tree);

    // Rotate key — old token no longer verifiable
    process.env.TREENIX_ANON_KEY = randomBytes(32).toString('hex');
    _resetAnonKeyForTests();

    const resolved = await resolveToken(tree, token);
    assert.equal(resolved, null, 'wrong key rejects token');
  });

  it('expired payload → null', async () => {
    const tree = createMemoryTree();
    const key = Buffer.from(TEST_KEY_HEX, 'hex');
    // Craft expired token manually
    const body = Buffer.from(JSON.stringify({
      id: randomBytes(16).toString('hex'),
      iat: Date.now() - 1000000,
      exp: Date.now() - 1000,
    })).toString('base64url');
    const sig = createHmac('sha256', key).update(body).digest('base64url');
    const expired = `anon.${body}.${sig}`;

    const resolved = await resolveToken(tree, expired);
    assert.equal(resolved, null, 'expired payload rejected');
  });

  it('malformed payload — non-string id → null', async () => {
    const tree = createMemoryTree();
    const key = Buffer.from(TEST_KEY_HEX, 'hex');
    const body = Buffer.from(JSON.stringify({ id: 42, exp: Date.now() + 1000 })).toString('base64url');
    const sig = createHmac('sha256', key).update(body).digest('base64url');
    assert.equal(await resolveToken(tree, `anon.${body}.${sig}`), null);
  });

  it('malformed payload — non-finite exp → null', async () => {
    const tree = createMemoryTree();
    const key = Buffer.from(TEST_KEY_HEX, 'hex');
    const body = Buffer.from('{"id":"deadbeef12345678deadbeef12345678","exp":1e999}').toString('base64url');
    const sig = createHmac('sha256', key).update(body).digest('base64url');
    assert.equal(await resolveToken(tree, `anon.${body}.${sig}`), null, 'Infinity exp rejected');
  });

  it('id format must be exactly 32 hex chars', async () => {
    const tree = createMemoryTree();
    const key = Buffer.from(TEST_KEY_HEX, 'hex');
    const body = Buffer.from(JSON.stringify({ id: 'short', exp: Date.now() + 1000 })).toString('base64url');
    const sig = createHmac('sha256', key).update(body).digest('base64url');
    assert.equal(await resolveToken(tree, `anon.${body}.${sig}`), null);
  });
});

describe('resolveOrIssueSession — auth dispatcher', () => {

  beforeEach(() => { process.env.TREENIX_ANON_KEY = TEST_KEY_HEX; });

  it('absent cookie+bearer → ok, issued anon session', async () => {
    const tree = createMemoryTree();
    const r = await resolveOrIssueSession(tree, null, null);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.issued, true);
    assert.equal(r.session.anonymous, true);
  });

  it('invalid bearer → bad_bearer (loud, no anon fallback)', async () => {
    const tree = createMemoryTree();
    const r = await resolveOrIssueSession(tree, null, 'not-a-valid-token');
    assert.equal(r.kind, 'bad_bearer');
  });

  it('valid anon cookie → ok, no issue', async () => {
    const tree = createMemoryTree();
    const { token } = await createAnonSession(tree);
    const r = await resolveOrIssueSession(tree, token, null);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.issued, false, 'existing valid cookie reused, no reissuance');
    assert.equal(r.token, token);
  });

  it('🚨 REGRESSION: invalid cookie (any shape) → expired_session, NEVER silent anon', async () => {
    const tree = createMemoryTree();

    // Fake user-session-shaped cookie (hex64) — never existed in tree
    const fakeUserCookie = randomBytes(32).toString('hex');
    const r1 = await resolveOrIssueSession(tree, fakeUserCookie, null);
    assert.equal(r1.kind, 'expired_session',
      'unknown hex64 cookie MUST fail loud, not silently become anon');

    // Garbage cookie
    const r2 = await resolveOrIssueSession(tree, 'garbage-cookie-value', null);
    assert.equal(r2.kind, 'expired_session', 'garbage cookie MUST fail loud');

    // Expired anon cookie (tampered to break sig)
    const { token } = await createAnonSession(tree);
    const broken = token.slice(0, -2) + 'XX';
    const r3 = await resolveOrIssueSession(tree, broken, null);
    assert.equal(r3.kind, 'expired_session', 'tampered anon cookie MUST fail loud, not refresh');
  });

  it('bearer takes precedence over cookie', async () => {
    const tree = createMemoryTree();
    const { token: anonToken } = await createAnonSession(tree);
    // Valid bearer + invalid cookie → bearer wins, no 401
    const r = await resolveOrIssueSession(tree, 'invalid-cookie-ignored', anonToken);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.token, anonToken, 'bearer used as credential');
  });
});

describe('cookie Max-Age separation', () => {

  it('default user cookie uses SESSION_TTL', () => {
    const cookie = buildSessionCookie('user-token');
    // Default param is in seconds — match against SESSION_TTL_MS/1000
    assert.match(cookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}\\b`));
  });

  it('anon cookie uses 1-year Max-Age (decoupled from user TTL)', () => {
    const cookie = buildSessionCookie('anon.token', ANON_COOKIE_MAX_AGE);
    assert.match(cookie, /Max-Age=31536000\b/, 'anon Max-Age = 365 days');
    assert.doesNotMatch(cookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}\\b`),
      'anon does NOT leak user TTL');
  });
});
