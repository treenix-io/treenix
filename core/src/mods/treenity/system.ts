// treenity.system — system actions: type discovery, view compilation, prefab deployment
// Registered as a class so actions appear in catalog and are callable via execute tool.
// Node at /sys has $type: treenity.system — all system actions route there.

import { getCtx, registerType } from '@treenity/core/comp';
import { verifyViewSource } from '@treenity/core/mods/uix/verify';
import { TypeCatalog } from '@treenity/core/schema/catalog';
import { deployPrefab } from '@treenity/core/server/prefab';

const catalog = new TypeCatalog();

/** @description System actions — type discovery, view compilation, prefab deployment */
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

  /** @description Compile JSX view source. With source: compile + save to type node. Without: check existing */
  async compile_view(data: { /** JSX source code */ source?: string; /** Type node path */ path?: string }) {
    const { store } = getCtx();
    const targetPath = data.path;

    let code = data.source;
    if (!code) {
      if (!targetPath) throw new Error('source or path required');
      const node = await store.get(targetPath);
      if (!node) throw new Error(`not found: ${targetPath}`);
      code = (node as any)?.view?.source;
      if (!code) throw new Error(`no view.source on ${targetPath}`);
    }

    const check = verifyViewSource(code);
    if (!check.ok) return check;

    if (data.source && targetPath) {
      const node = await store.get(targetPath);
      if (node) {
        (node as any).view = { ...((node as any).view ?? {}), source: data.source };
        await store.set(node);
        return { ok: true, saved: targetPath };
      }
    }
    return check;
  }

  /** @description Deploy module prefab template to target path. Idempotent */
  async deploy_prefab(data: {
    /** Prefab source path, e.g. /sys/mods/cafe/prefabs/default */ source: string;
    /** Target path where nodes will be created */ target: string;
    /** Allow writing outside target */ allowAbsolute?: boolean;
  }) {
    const { store } = getCtx();
    return deployPrefab(store, data.source, data.target, { allowAbsolute: !!data.allowAbsolute });
  }
}

registerType('treenity.system', SystemActions);
