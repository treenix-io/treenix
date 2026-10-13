import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// Launcher — iPhone-like home screen for Treenix

import { registerType } from '@treenx/core/comp';

/** Home screen with icon grid + widgets. Layout via react-grid-layout. */
export class Launcher {
  columns = 4;
  wallpaper = 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)';
  /** JSON-stringified RGL layout: [{i, x, y, w, h}] */
  layout = '[]';

  /** Persist layout after drag/resize */
  updateLayout(data: { /** JSON-stringified RGL layout */ layout: string }) {
    if (!data.layout) throw new Error('layout required');
    this.layout = data.layout;
  }
}

registerType('launcher', Launcher);

export interface Launcher {
  /** Add an app shortcut (ref) to the launcher */
  addApp(data: { /** Target node path */ path: string; /** Layout item id */ id?: string }): Promise<void>;

  /** Remove an app from the launcher */
  removeApp(data: { /** Child id (last path segment) */ id: string }): Promise<void>;
}

export const clientModules = [declareOpenModule('@treenx/mods/launcher/types', [], [
  declareClientType('launcher', Launcher),
])];
