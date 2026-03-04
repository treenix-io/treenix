// Launcher — iPhone-like home screen for Treenity

import { getCtx, registerType } from '@treenity/core/comp';
import type { NodeData } from '@treenity/core/core';

/** Home screen with icon grid + widgets. Layout via react-grid-layout. */
export class Launcher {
  columns = 4;
  wallpaper = 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)';
  /** JSON-stringified RGL layout: [{i, x, y, w, h}] */
  layout = '[]';

  /** Add an app shortcut (ref) to the launcher */
  async addApp(data: { /** Target node path */ path: string; /** Layout item id */ id?: string }) {
    if (!data.path?.trim()) throw new Error('path required');
    const ctx = getCtx();
    const id = data.id || data.path.split('/').at(-1) || Date.now().toString(36);
    const refPath = `${ctx.node.$path}/${id}`;

    await ctx.store.set({ $path: refPath, $type: 'ref', $ref: data.path } as NodeData);

    // Auto-place in layout as 1×1
    const items: { i: string; x: number; y: number; w: number; h: number }[] = JSON.parse(this.layout || '[]');
    const maxY = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    const lastRowItems = items.filter(it => it.y + it.h === maxY);
    const nextX = lastRowItems.reduce((m, it) => Math.max(m, it.x + it.w), 0);

    if (nextX < this.columns) {
      items.push({ i: id, x: nextX, y: maxY > 0 ? maxY - 1 : 0, w: 1, h: 1 });
    } else {
      items.push({ i: id, x: 0, y: maxY, w: 1, h: 1 });
    }
    this.layout = JSON.stringify(items);
  }

  /** Remove an app from the launcher */
  async removeApp(data: { /** Child id (last path segment) */ id: string }) {
    if (!data.id?.trim()) throw new Error('id required');
    const ctx = getCtx();
    await ctx.store.remove(`${ctx.node.$path}/${data.id}`);

    const items: { i: string }[] = JSON.parse(this.layout || '[]');
    this.layout = JSON.stringify(items.filter(it => it.i !== data.id));
  }

  /** Persist layout after drag/resize */
  updateLayout(data: { /** JSON-stringified RGL layout */ layout: string }) {
    if (!data.layout) throw new Error('layout required');
    this.layout = data.layout;
  }
}

registerType('launcher', Launcher);
