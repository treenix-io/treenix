import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerType } from '@treenity/core/comp';
import { resolve, unregister } from '@treenity/core';
import { view } from '#view';

class TestWidget {
  label = '';
}
registerType('test.widget', TestWidget);

describe('view()', () => {
  beforeEach(() => {
    unregister('test.widget', 'react');
    unregister('test.widget', 'react:list');
    unregister('test.widget', 'react:compact');
    unregister('test.widget', 'react:edit');
    unregister('test.widget', 'react:preview');
    unregister('test.widget', 'react:custom');
  });

  it('registers default react view', () => {
    const handler = () => null;
    view(TestWidget, handler);
    assert.equal(resolve('test.widget', 'react', false), handler);
  });

  it('view.list registers react:list', () => {
    const handler = () => null;
    view.list(TestWidget, handler);
    assert.equal(resolve('test.widget', 'react:list', false), handler);
  });

  it('view.compact registers react:compact', () => {
    const handler = () => null;
    view.compact(TestWidget, handler);
    assert.equal(resolve('test.widget', 'react:compact', false), handler);
  });

  it('view.edit registers react:edit', () => {
    const handler = () => null;
    view.edit(TestWidget, handler);
    assert.equal(resolve('test.widget', 'react:edit', false), handler);
  });

  it('view.preview registers react:preview', () => {
    const handler = () => null;
    view.preview(TestWidget, handler);
    assert.equal(resolve('test.widget', 'react:preview', false), handler);
  });

  it('view(Type, "custom", fn) registers react:custom', () => {
    const handler = () => null;
    view(TestWidget, 'custom', handler);
    assert.equal(resolve('test.widget', 'react:custom', false), handler);
  });
});
