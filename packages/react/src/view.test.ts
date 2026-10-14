import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClientRegistry, declareClientModule } from '#context/client-registry';
import { view } from '#view';

class TestWidget {
  static $type = 'test.widget';
  label = '';
}

describe('view()', () => {
  it('registers default react view', () => {
    const handler = () => null;
    const registry = createClientRegistry([
      declareClientModule('widget-views', [view(TestWidget, handler)]),
    ]);
    assert.equal(registry.resolve('test.widget', 'react')?.handler, handler);
  });

  it('view.list registers react:list', () => {
    const handler = () => null;
    const registry = createClientRegistry([
      declareClientModule('widget-views', [view.list(TestWidget, handler)]),
    ]);
    assert.equal(registry.resolve('test.widget', 'react:list')?.handler, handler);
  });

  it('view.compact registers react:compact', () => {
    const handler = () => null;
    const registry = createClientRegistry([
      declareClientModule('widget-views', [view.compact(TestWidget, handler)]),
    ]);
    assert.equal(registry.resolve('test.widget', 'react:compact')?.handler, handler);
  });

  it('view.edit registers react:edit', () => {
    const handler = () => null;
    const registry = createClientRegistry([
      declareClientModule('widget-views', [view.edit(TestWidget, handler)]),
    ]);
    assert.equal(registry.resolve('test.widget', 'react:edit')?.handler, handler);
  });

  it('view.preview registers react:preview', () => {
    const handler = () => null;
    const registry = createClientRegistry([
      declareClientModule('widget-views', [view.preview(TestWidget, handler)]),
    ]);
    assert.equal(registry.resolve('test.widget', 'react:preview')?.handler, handler);
  });

  it('view(Type, "custom", fn) registers react:custom', () => {
    const handler = () => null;
    const registry = createClientRegistry([
      declareClientModule('widget-views', [view(TestWidget, 'custom', handler)]),
    ]);
    assert.equal(registry.resolve('test.widget', 'react:custom')?.handler, handler);
  });
});
