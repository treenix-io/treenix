// t.prefab — prefab node type with deploy action
// Lives at /sys/mods/{mod}/prefabs/{name} in the virtual mods mount.
// deploy() seeds the prefab's nodes into the target path.

import { getCtx, registerType } from '@treenity/core/comp';
import { deployByKey } from '@treenity/core/server/prefab';

export class Prefab {
  mod = '';
  name = '';

  /** @description Deploy this prefab's nodes into target path. Idempotent — skips existing nodes */
  async deploy(data: {
    /** Target path where nodes will be created, e.g. "/" or "/my/site" */ target: string;
    /** Allow writing outside target (e.g. /sys/autostart refs) */ allowAbsolute?: boolean;
  }) {
    const { tree } = getCtx();
    return deployByKey(tree, this.mod, this.name, data.target, {
      allowAbsolute: !!data.allowAbsolute,
    });
  }
}

registerType('t.prefab', Prefab);
