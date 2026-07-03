// ── Anonymous sessions (signed, stateless) ──
//
// Anon token format: `anon.<base64url(payload)>.<base64url(hmac-sha256(payload, key))>`
// Payload: { id, iat, exp }, id = 16-byte hex.
// userId = `anon:<id>` — publishable, safe in $owner/audit/watch keys (NOT bearer token).
// Server stores nothing — verify-only. Cross-restart/cross-node identity persistence via env-key.
//
// Closes core-t9d silent-downgrade hole: middleware no longer falls back to claims=['public']
// without identity; anon is a real signed identity issued at the HTTP layer.

import { A, R, S, W } from '#core';
import type { Tree } from '#tree';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AnonSession } from './sessions';

export const ANON_PREFIX = 'anon.';
const ANON_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year — returning-visitor identity persistence
const ANON_KEY_PATH = '/auth/secrets/anon-key';

let anonKeyCache: Buffer | null = null;
let anonKeyPromise: Promise<Buffer> | null = null; // race-serialize concurrent first-callers

/** Exported for boot validation in factory.ts and tests. */
export async function getAnonKey(tree: Tree): Promise<Buffer> {
  if (anonKeyCache) return anonKeyCache;
  if (anonKeyPromise) return anonKeyPromise;
  anonKeyPromise = (async () => {
    const envKey = process.env.TREENIX_ANON_KEY;
    if (envKey) {
      if (!/^[0-9a-f]{64}$/.test(envKey)) {
        throw new Error('TREENIX_ANON_KEY must be 64 hex chars (32 bytes)');
      }
      anonKeyCache = Buffer.from(envKey, 'hex');
      return anonKeyCache;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TREENIX_ANON_KEY required in production (no env fallback)');
    }
    // Dev fallback: persistent tree-backed key, lazy-created
    const node = await tree.get(ANON_KEY_PATH);
    if (node) {
      // Node exists — require valid key. Don't silently re-mint over corrupt field.
      const keyVal = node['key'];
      if (typeof keyVal !== 'string') {
        throw new Error(`malformed anon key at ${ANON_KEY_PATH} (key field missing or not string)`);
      }
      if (!/^[0-9a-f]{64}$/.test(keyVal)) {
        throw new Error(`malformed anon key at ${ANON_KEY_PATH} (must be 64 hex chars)`);
      }
      anonKeyCache = Buffer.from(keyVal, 'hex');
      return anonKeyCache;
    }
    const key = randomBytes(32);
    await tree.set({
      $path: ANON_KEY_PATH, $type: 'secret',
      // Explicit deny on inheritance: admins read/write, authenticated and public denied.
      // Without explicit zeros, authenticated users could inherit read from a parent
      // and mint arbitrary anons by extracting the key.
      $acl: [
        { g: 'admins', p: R | W | A | S },
        { g: 'authenticated', p: 0 },
        { g: 'public', p: 0 },
      ],
      key: key.toString('hex'),
    });
    anonKeyCache = key;
    return key;
  })().catch((e) => { anonKeyPromise = null; throw e; });
  return anonKeyPromise;
}

function signAnon(id: string, key: Buffer): string {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ id, iat: now, exp: now + ANON_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${ANON_PREFIX}${body}.${sig}`;
}

export function verifyAnon(token: string, key: Buffer): { id: string; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'anon') return null;
  const [, body, sig] = parts;
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { id?: unknown; exp?: unknown };
    if (typeof p.id !== 'string' || !/^[0-9a-f]{32}$/.test(p.id)) return null;
    if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null;
    if (p.exp < Date.now()) return null;
    return { id: p.id, exp: p.exp };
  } catch { return null; }
}

export async function createAnonSession(tree: Tree): Promise<{ session: AnonSession; token: string }> {
  const key = await getAnonKey(tree);
  const id = randomBytes(16).toString('hex');
  const token = signAnon(id, key);
  return { session: { userId: `anon:${id}`, claims: ['public'], anonymous: true }, token };
}

/** Test-only: clear module-global anon key state between test cases. */
export function _resetAnonKeyForTests(): void {
  anonKeyCache = null;
  anonKeyPromise = null;
}
