// t.system — system actions: type discovery and prefab deployment
// Registered as a class so actions appear in catalog and are callable via execute tool.
// Node at /sys has $type: t.system — all system actions route there.

import { registerType } from '#comp';
import type { NativeTypeDescription } from '#kernel/type-description';
import { loadSchemasFromDir } from '#schema/load';


/** @description System actions — type discovery and prefab deployment */
export class SystemActions {
}

registerType('t.system', SystemActions);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);

export interface SystemActions {
  /** @read @description List all registered types with properties and actions */
  catalog(): Promise<NativeTypeDescription[]>;

  /** @read @description Search types by keyword across names, properties, and actions */
  search_types(data: { /** Search keyword */ query: string }): Promise<NativeTypeDescription[]>;

  /** @read @description Full type schema with properties, actions, args, and cross-references */
  describe_type(data: {
    /** Type name, e.g. "cafe.contact" */ type: string;
  }): Promise<NativeTypeDescription>;

  /** @description Deploy module prefab template to target path. Idempotent */
  deploy_prefab(data: {
    /** Prefab source path, e.g. /sys/mods/cafe/prefabs/default */ source: string;
    /** Target path where nodes will be created */ target: string;
    /** Allow writing outside target */ allowAbsolute?: boolean;
  }): Promise<{ deployed: string[]; skipped: string[] }>;
}
