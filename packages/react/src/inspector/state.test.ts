import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getInspectorState, inspectorActions } from '#inspector/state';

describe('inspector state store', () => {
  beforeEach(() => {
    inspectorActions.__reset();
  });

  it('initial state has root selection', () => {
    const s = getInspectorState();
    assert.equal(s.selectedPath, '/');
    assert.equal(s.root, '/');
    assert.deepEqual(s.expanded, []);
    assert.equal(s.filter, '');
    assert.equal(s.showHidden, false);
    assert.equal(s.sidebarCollapsed, false);
  });

  it('select() updates selectedPath', () => {
    inspectorActions.select('/foo/bar');
    assert.equal(getInspectorState().selectedPath, '/foo/bar');
  });

  it('select() does not mutate other fields', () => {
    inspectorActions.setFilter('hello');
    inspectorActions.select('/x');
    assert.equal(getInspectorState().filter, 'hello');
  });

  it('toggleExpand adds then removes a path', () => {
    inspectorActions.toggleExpand('/a');
    assert.deepEqual(getInspectorState().expanded, ['/a']);
    inspectorActions.toggleExpand('/b');
    assert.deepEqual(getInspectorState().expanded, ['/a', '/b']);
    inspectorActions.toggleExpand('/a');
    assert.deepEqual(getInspectorState().expanded, ['/b']);
  });

  it('setExpanded replaces the set', () => {
    inspectorActions.toggleExpand('/a');
    inspectorActions.setExpanded(['/x', '/y']);
    assert.deepEqual(getInspectorState().expanded, ['/x', '/y']);
  });

  it('toggleHidden flips boolean', () => {
    assert.equal(getInspectorState().showHidden, false);
    inspectorActions.toggleHidden();
    assert.equal(getInspectorState().showHidden, true);
    inspectorActions.toggleHidden();
    assert.equal(getInspectorState().showHidden, false);
  });

  it('toggleSidebar flips boolean', () => {
    assert.equal(getInspectorState().sidebarCollapsed, false);
    inspectorActions.toggleSidebar();
    assert.equal(getInspectorState().sidebarCollapsed, true);
  });

  it('setFilter sets text', () => {
    inspectorActions.setFilter('search');
    assert.equal(getInspectorState().filter, 'search');
  });

  it('setRoot updates root', () => {
    inspectorActions.setRoot('/sys');
    assert.equal(getInspectorState().root, '/sys');
  });

  it('state object identity changes on update (for useSyncExternalStore)', () => {
    const before = getInspectorState();
    inspectorActions.select('/x');
    const after = getInspectorState();
    assert.notEqual(before, after, 'state must be a new object reference after mutation');
  });

  it('expanded array identity changes on toggle (for selector eq)', () => {
    const before = getInspectorState().expanded;
    inspectorActions.toggleExpand('/a');
    const after = getInspectorState().expanded;
    assert.notEqual(before, after);
  });
});
