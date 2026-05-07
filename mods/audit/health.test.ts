// Health flag — flips to unhealthy when audit append fails.
// Server middleware reads this to refuse requests until restart.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { isHealthy, markUnhealthy, resetHealthForTest, unhealthyReason } from './health';

afterEach(() => resetHealthForTest());

describe('health flag', () => {
  it('starts healthy by default', () => {
    assert.equal(isHealthy(), true);
    assert.equal(unhealthyReason(), '');
  });

  it('markUnhealthy flips flag and stores reason', () => {
    markUnhealthy('audit append failed: ENOSPC');
    assert.equal(isHealthy(), false);
    assert.equal(unhealthyReason(), 'audit append failed: ENOSPC');
  });

  it('subsequent markUnhealthy keeps first reason (sticky)', () => {
    markUnhealthy('first failure');
    markUnhealthy('second failure');
    assert.equal(unhealthyReason(), 'first failure');
  });
});
