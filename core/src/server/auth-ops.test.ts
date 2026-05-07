// F5 — IP-bucket rate-limit for unauth flows.
// Attacker rotating userId across requests must trip the per-IP bucket.
// Per-userId bucket and per-IP bucket are independent — both must allow.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createMemoryTree } from '#tree';
import { OpError } from '#errors';
import { registerUser, loginUser } from './auth-ops';

function uniqueIp(): string {
  // Per-test ip — module-level rate-limit Map persists across tests.
  return `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
}

describe('F5 — IP bucket rate-limit', () => {
  it('register: trips IP bucket when attacker rotates userId from one IP', async () => {
    const tree = createMemoryTree();
    const ip = uniqueIp();

    // 5 registrations from one IP succeed.
    for (let i = 0; i < 5; i++) {
      await registerUser(tree, `u${randomBytes(4).toString('hex')}`, 'pw', ip);
    }

    // 6th attempt from same IP with a fresh userId — IP bucket (limit 5) trips.
    await assert.rejects(
      registerUser(tree, `u${randomBytes(4).toString('hex')}`, 'pw', ip),
      (e: unknown) => e instanceof OpError && e.code === 'TOO_MANY_REQUESTS',
    );
  });

  it('register: per-userId bucket trips on repeated attempts to same userId', async () => {
    const tree = createMemoryTree();
    const userId = `u${randomBytes(4).toString('hex')}`;

    // First registration succeeds.
    await registerUser(tree, userId, 'pw', uniqueIp());
    // 2nd & 3rd attempts to same userId — CONFLICT (already exists), still consume bucket slots.
    await assert.rejects(registerUser(tree, userId, 'pw', uniqueIp()), (e: unknown) => e instanceof OpError);
    await assert.rejects(registerUser(tree, userId, 'pw', uniqueIp()), (e: unknown) => e instanceof OpError);
    // 4th — user bucket (limit 3) trips with TOO_MANY_REQUESTS even from a fresh IP.
    await assert.rejects(
      registerUser(tree, userId, 'pw', uniqueIp()),
      (e: unknown) => e instanceof OpError && e.code === 'TOO_MANY_REQUESTS',
    );
  });

  it('register: clientIp=null skips IP bucket (in-memory / non-HTTP callers preserved)', async () => {
    const tree = createMemoryTree();
    // Without an IP, only the per-userId bucket applies — many distinct userIds work.
    for (let i = 0; i < 10; i++) {
      await registerUser(tree, `u${randomBytes(4).toString('hex')}`, 'pw', null);
    }
  });

  // Codex round 3 #2 regression: TOCTOU on first-user admin election.
  // Concurrent registers on a fresh store must produce exactly ONE admin.
  it('register: serializes concurrent first-user calls (no double-admin)', async () => {
    const tree = createMemoryTree();

    // Fire 5 concurrent registers — without serialization multiple would observe
    // items.length === 0 and grant themselves admins.
    const userIds = Array.from({ length: 5 }, () => `u${randomBytes(4).toString('hex')}`);
    const results = await Promise.allSettled(
      userIds.map((u) => registerUser(tree, u, 'pw', null)),
    );

    let admins = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.pending === false) admins++;
    }
    assert.equal(admins, 1, 'exactly one register call should produce an active (admin) user');

    // Verify in tree: exactly one user has groups.list including 'admins'.
    const { items } = await tree.getChildren('/auth/users');
    const adminCount = items.filter((u: any) => {
      const g = u['groups'];
      return g && Array.isArray(g.list) && g.list.includes('admins');
    }).length;
    assert.equal(adminCount, 1, 'tree state must show exactly one admin');
  });

  it('login: trips IP bucket when attacker rotates target userId from one IP', async () => {
    const tree = createMemoryTree();
    const ip = uniqueIp();

    // 10 failed logins with rotating userIds — all reject UNAUTHORIZED, but each consumes IP bucket.
    for (let i = 0; i < 10; i++) {
      await assert.rejects(
        loginUser(tree, `u${randomBytes(4).toString('hex')}`, 'pw', ip),
        (e: unknown) => e instanceof OpError && e.code === 'UNAUTHORIZED',
      );
    }
    // 11th — IP bucket (limit 10) trips.
    await assert.rejects(
      loginUser(tree, `u${randomBytes(4).toString('hex')}`, 'pw', ip),
      (e: unknown) => e instanceof OpError && e.code === 'TOO_MANY_REQUESTS',
    );
  });
});

describe('R4-AUTH-8 — assertUserId path-traversal hardening', () => {
  const reject = (userId: string) => async () => {
    const tree = createMemoryTree();
    await assert.rejects(
      registerUser(tree, userId, 'pw', uniqueIp()),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  };

  it('rejects ".." (parent traversal)',  reject('..'));
  it('rejects "."   (current dir)',      reject('.'));
  it('rejects "..." (dot-only multi)',   reject('...'));
  it('rejects empty string',              reject(''));
  it('rejects userId with slash',         reject('a/b'));
  it('rejects userId with backslash',     reject('a\\b'));
  it('rejects userId with NUL',           reject('a\0b'));
  it('rejects userId with colon',         reject('agent:x'));
  it('rejects userId with space',         reject('a b'));
  it('rejects userId with quote',         reject('a"b'));
  it('rejects oversize userId (>64)',     reject('x'.repeat(65)));

  it('accepts alphanumeric with allowed punctuation (._-)', async () => {
    const tree = createMemoryTree();
    // First user gets admin — single registration sufficient for the assertion.
    await registerUser(tree, 'good.user_name-1', 'pw', uniqueIp());
  });
});

describe('R4-AUTH-6 — pending-status credential oracle closed', () => {
  it('login on pending account returns UNAUTHORIZED, not FORBIDDEN', async () => {
    const tree = createMemoryTree();
    // First user becomes admin/active automatically. Register a second to get a pending user.
    await registerUser(tree, 'admin1', 'adminpw', uniqueIp());
    await registerUser(tree, 'bob', 'bobpw', uniqueIp());

    // Bob's status is pending. Correct password → must NOT leak that.
    await assert.rejects(
      loginUser(tree, 'bob', 'bobpw', uniqueIp()),
      (e: unknown) => e instanceof OpError
        && e.code === 'UNAUTHORIZED'
        && e.message === 'Invalid credentials',
    );

    // Wrong password must produce identical shape — same code, same message.
    await assert.rejects(
      loginUser(tree, 'bob', 'wrongpw', uniqueIp()),
      (e: unknown) => e instanceof OpError
        && e.code === 'UNAUTHORIZED'
        && e.message === 'Invalid credentials',
    );
  });
});
