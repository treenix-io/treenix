import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TickerConfig } from './types';

describe('TickerConfig', () => {
  it('has sensible defaults', () => {
    const c = new TickerConfig();
    assert.equal(c.symbol, 'BTC');
    assert.equal(c.intervalSec, 10);
  });

  it('configure updates fields', () => {
    const c = new TickerConfig();
    c.configure({ symbol: 'ETH', intervalSec: 30 });
    assert.equal(c.symbol, 'ETH');
    assert.equal(c.intervalSec, 30);
  });
});
