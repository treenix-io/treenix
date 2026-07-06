// ULID — 26-char Crockford base32: 48-bit ms timestamp + 80-bit randomness.
// Node identity format (core-gk8.10): time-ordered prefix keeps ids sortable
// by creation (audit/journal-friendly), zero deps via globalThis.crypto.
// Chosen over UUIDv7 (same timestamp layout, RFC 9562): $id lives as a JSON
// string everywhere in the stack — no native 16-byte uuid column to exploit —
// and 26 dash-free chars beat 36 in refs/paths/agent contexts; entropy is
// higher too (80 vs 74 random bits). Timestamp bits map 1:1 if an RFC-UUID
// integration ever forces a migration.

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }

  // 256 % 32 === 0 — the modulo is bias-free.
  const rnd = new Uint8Array(16);
  globalThis.crypto.getRandomValues(rnd);
  let out = ts;
  for (let i = 0; i < 16; i++) out += B32[rnd[i] % 32];
  return out;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(v: unknown): v is string {
  return typeof v === 'string' && ULID_RE.test(v);
}
