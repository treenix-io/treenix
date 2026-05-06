// Short-lived tokens for SSE handshakes. Long-lived bearer never appears in connectionParams.

import { randomBytes } from 'node:crypto';
import type { Session } from './auth';

const STREAM_TTL_MS = 5 * 60_000;
const CLEANUP_MS = 60_000;

export type StreamTokenStore = {
  mint(session: Session): { token: string; expiresInMs: number };
  resolve(token: string): Session | null;
  purgeForUser(userId: string): void;
};

export function createStreamTokenStore(): StreamTokenStore {
  const tokens = new Map<string, { session: Session; expiresAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [t, v] of tokens) if (now > v.expiresAt) tokens.delete(t);
  }, CLEANUP_MS).unref();

  return {
    mint(session) {
      const token = randomBytes(32).toString('hex');
      tokens.set(token, { session, expiresAt: Date.now() + STREAM_TTL_MS });
      return { token, expiresInMs: STREAM_TTL_MS };
    },
    resolve(token) {
      const entry = tokens.get(token);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        tokens.delete(token);
        return null;
      }
      return entry.session;
    },
    purgeForUser(userId) {
      for (const [t, v] of tokens) if (v.session.userId === userId) tokens.delete(t);
    },
  };
}
