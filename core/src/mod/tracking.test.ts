import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clearTracking, getCurrentMod, getTypesForMod, inferModFromType, setCurrentMod, trackType } from './tracking';

describe('mod/tracking', () => {
  afterEach(() => clearTracking());

  it('setCurrentMod + trackType maps type to mod', () => {
    setCurrentMod('cafe');
    trackType('cafe.contact');
    trackType('cafe.mail');
    setCurrentMod(null);

    assert.deepEqual(getTypesForMod('cafe').sort(), ['cafe.contact', 'cafe.mail']);
  });

  it('trackType without currentMod does not track', () => {
    trackType('orphan.type');
    assert.deepEqual(getTypesForMod('orphan'), []);
  });

  it('getTypesForMod returns empty for unknown mod', () => {
    assert.deepEqual(getTypesForMod('nope'), []);
  });

  it('getCurrentMod reflects setCurrentMod', () => {
    assert.equal(getCurrentMod(), null);
    setCurrentMod('test');
    assert.equal(getCurrentMod(), 'test');
    setCurrentMod(null);
    assert.equal(getCurrentMod(), null);
  });

  it('inferModFromType uses tracked mapping first', () => {
    setCurrentMod('my-cafe');
    trackType('cafe.contact');
    setCurrentMod(null);

    assert.equal(inferModFromType('cafe.contact'), 'my-cafe');
  });

  it('inferModFromType falls back to first segment', () => {
    assert.equal(inferModFromType('sim.agent'), 'sim');
    assert.equal(inferModFromType('mabu.block.hero'), 'mabu');
  });

  it('inferModFromType uses alias map', () => {
    assert.equal(inferModFromType('order.status'), 'orders');
  });

  it('clearTracking resets all state', () => {
    setCurrentMod('x');
    trackType('x.foo');
    clearTracking();

    assert.equal(getCurrentMod(), null);
    assert.deepEqual(getTypesForMod('x'), []);
  });
});
