import assert from 'node:assert/strict';
import { it } from 'node:test';
import { _roots, act, createRoot, unmountComponentAtNode } from '@react-three/fiber';
import { Scene } from 'three';

it('the 3D renderer creates its frame clock without compatibility warnings', { timeout: 3000 }, async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const canvas = document.createElement('canvas');
  createRoot(canvas);
  _roots.get(canvas)!.store.getState().scene = new Scene();
  try {
    assert.equal(warnings.mock.callCount(), 0);
  } finally {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    await act(async () => unmountComponentAtNode(canvas, release));
    await released;
  }
});
