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
