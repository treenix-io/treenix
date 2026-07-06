import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUlid, ulid } from './ulid';

describe('ulid (core-gk8.10)', () => {
  it('produces 26-char Crockford base32, accepted by isUlid', () => {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.ok(isUlid(id));
  });

  it('time prefix sorts lexicographically by creation time', () => {
    const early = ulid(1_000_000);
    const late = ulid(2_000_000);
    assert.ok(early < late);
  });

  it('ids are unique across a burst', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    assert.equal(ids.size, 1000);
  });

  it('isUlid rejects non-ulid values', () => {
    for (const bad of ['', 'short', ulid().toLowerCase(), 'I'.repeat(26), 42, null, undefined]) {
      assert.equal(isUlid(bad), false, `must reject ${JSON.stringify(bad)}`);
    }
  });
});
