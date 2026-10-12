// Launcher — iPhone-like home screen for Treenix

import type { NodeData } from '@treenx/core';
import { getCtx, registerType } from '@treenx/core/comp';
import { appendLauncherItem, removeLauncherItem } from '#launcher/layout';

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

    await ctx.tree.set({ $path: refPath, $type: 'ref', $ref: data.path } as NodeData);

    // Auto-place in layout as 1×1
    this.layout = appendLauncherItem(this.layout, this.columns, id);
  }

  /** Remove an app from the launcher */
  async removeApp(data: { /** Child id (last path segment) */ id: string }) {
    if (!data.id?.trim()) throw new Error('id required');
    const ctx = getCtx();
    await ctx.tree.remove(`${ctx.node.$path}/${data.id}`);

    this.layout = removeLauncherItem(this.layout, data.id);
  }

  /** Persist layout after drag/resize */
  updateLayout(data: { /** JSON-stringified RGL layout */ layout: string }) {
    if (!data.layout) throw new Error('layout required');
    this.layout = data.layout;
  }
}

registerType('launcher', Launcher);
