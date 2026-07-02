// Health flag — flips to unhealthy when audit append fails, heals on a
// successful append (organic or via the checkHealth recovery probe, core-98jr).

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  checkHealth, isHealthy, markHealthy, markUnhealthy,
  resetHealthForTest, setRecoveryProbe, unhealthyReason,
} from './health';

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

  it('repeated markUnhealthy keeps the first reason (root cause, not cascade)', () => {
    markUnhealthy('first failure');
    markUnhealthy('second failure');
    assert.equal(unhealthyReason(), 'first failure');
  });

  it('markHealthy heals and clears the reason', () => {
    markUnhealthy('down');
    markHealthy();
    assert.equal(isHealthy(), true);
    assert.equal(unhealthyReason(), '');
  });

  it('a new failure after healing records the new reason', () => {
    markUnhealthy('first outage');
    markHealthy();
    markUnhealthy('second outage');
    assert.equal(unhealthyReason(), 'second outage');
  });
});

describe('checkHealth recovery probe', () => {
  it('healthy: returns state without probing', async () => {
    let probed = 0;
    setRecoveryProbe(async () => { probed++; });
    const state = await checkHealth();
    assert.equal(state.healthy, true);
    assert.equal(probed, 0, 'no probe while healthy');
  });

  it('unhealthy + successful probe → heals', async () => {
    markUnhealthy('down');
    setRecoveryProbe(async () => {});
    const state = await checkHealth();
    assert.equal(state.healthy, true);
  });

  it('unhealthy + failing probe → stays unhealthy, does not throw', async () => {
    markUnhealthy('down');
    setRecoveryProbe(async () => { throw new Error('still down'); });
    const state = await checkHealth();
    assert.equal(state.healthy, false);
    assert.equal(state.reason, 'down', 'first reason preserved');
  });

  it('probe attempts are throttled — back-to-back checks probe once', async () => {
    markUnhealthy('down');
    let probed = 0;
    setRecoveryProbe(async () => { probed++; throw new Error('still down'); });
    await checkHealth();
    await checkHealth();
    assert.equal(probed, 1, 'second check inside the interval skips the probe');
  });

  it('unhealthy without a registered probe → state reported as-is', async () => {
    markUnhealthy('down');
    const state = await checkHealth();
    assert.equal(state.healthy, false);
  });
});
