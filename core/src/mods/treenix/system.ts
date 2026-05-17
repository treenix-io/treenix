// treenix.system — system actions: type discovery and prefab deployment
// Registered as a class so actions appear in catalog and are callable via execute tool.
// Node at /sys has $type: treenix.system — all system actions route there.

import { getCtx, registerType } from '@treenx/core/comp';
import { TypeCatalog } from '@treenx/core/schema/catalog';
import { deployPrefab } from '@treenx/core/server/prefab';

const catalog = new TypeCatalog();

/** @description System actions — type discovery and prefab deployment */
export class SystemActions {
  /** @description List all registered types with properties and actions */
  async catalog() {
    return catalog.list();
  }

  /** @description Search types by keyword across names, properties, and actions */
  async search_types(data: { /** Search keyword */ query: string }) {
    return catalog.search(data.query);
  }

  /** @description Full type schema with properties, actions, args, and cross-references */
  async describe_type(data: { /** Type name, e.g. "cafe.contact" */ type: string }) {
    const desc = catalog.describe(data.type);
    if (!desc) throw new Error(`type not found: ${data.type}`);
    return desc;
  }

  /** @description Deploy module prefab template to target path. Idempotent */
  async deploy_prefab(data: {
    /** Prefab source path, e.g. /sys/mods/cafe/prefabs/default */ source: string;
    /** Target path where nodes will be created */ target: string;
    /** Allow writing outside target */ allowAbsolute?: boolean;
  }) {
    const { tree } = getCtx();
    return deployPrefab(tree, data.source, data.target, { allowAbsolute: !!data.allowAbsolute });
  }
}

registerType('treenix.system', SystemActions);
