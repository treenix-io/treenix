// ── Cookie auth (browser) ──
// Replaces the F9 stream-token machinery with HttpOnly cookies. Browsers send
// cookies on every request including SSE EventSource — no mintStreamToken dance needed.
// SameSite=Strict closes CSRF since browser refuses cookie on cross-origin POST/GET-with-credentials.
// Bearer-in-Authorization-header continues to work in parallel for agents/MCP/tests.

export const SESSION_COOKIE = 'treenix_session';

export const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
// Anon cookies live a year — server has no storage cost (signed stateless tokens) and
// returning-visitor identity persistence is a feature (analytics/UX).
export const ANON_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export function buildSessionCookie(token: string, maxAgeSeconds: number = SESSION_COOKIE_MAX_AGE): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Parse `${SESSION_COOKIE}=<token>` from a Cookie header. Returns null if absent. */
export function parseSessionCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === SESSION_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}
