// t.prefab — prefab node type with deploy action
// Lives at /sys/mods/{mod}/prefabs/{name} in the virtual mods mount.
// deploy() seeds the prefab's nodes into the target path.

import { registerType } from '#comp';
import type { NodeInput } from '#kernel/types';
import { loadSchemasFromDir } from '#schema/load';

export class Prefab {
  mod = '';
  name = '';
  nodes?: readonly NodeInput[];
}

registerType('t.prefab', Prefab);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);

export interface Prefab {
  /** @description Deploy this prefab's nodes into target path. Idempotent — skips existing nodes */
  deploy(data: {
    /** Target path where nodes will be created, e.g. "/" or "/my/site" */ target: string;
    /** Allow writing outside target (e.g. /sys/autostart refs) */ allowAbsolute?: boolean;
  }): Promise<{ deployed: string[]; skipped: string[] }>;
}
