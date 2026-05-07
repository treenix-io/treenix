// treenix.system — system actions: type discovery, view compilation, prefab deployment
// Registered as a class so actions appear in catalog and are callable via execute tool.
// Node at /sys has $type: treenix.system — all system actions route there.

import { getComponent } from '@treenx/core';
import { getCtx, registerType, setComponent } from '@treenx/core/comp';
import { UixSource, verifyViewSource } from '@treenx/core/mods/uix/uix-source';
import { TypeCatalog } from '@treenx/core/schema/catalog';
import { applyTemplate } from '@treenx/core/server/actions';
import { deployPrefab } from '@treenx/core/server/prefab';

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
    const { tree } = getCtx();
    const targetPath = data.path;

    let code = data.source;
    if (!code) {
      if (!targetPath) throw new Error('source or path required');
      const node = await tree.get(targetPath);
      if (!node) throw new Error(`not found: ${targetPath}`);
      const view = getComponent(node, UixSource, 'view');
      if (!view?.source) throw new Error(`no uix.source on ${targetPath}`);
      code = view.source;
    }

    const check = verifyViewSource(code);
    if (!check.ok) return check;

    if (data.source && targetPath) {
      const node = await tree.get(targetPath);
      if (node) {
        setComponent(node, UixSource, { source: data.source }, 'view');
        await tree.set(node);
        return { ok: true, saved: targetPath };
      }
    }
    return check;
  }

  /** @description Apply template: copy children from template path to target path */
  async apply_template(data: {
    /** Source template path, e.g. /templates/blog */ templatePath: string;
    /** Target path where template children will be copied */ targetPath: string;
  }) {
    const { tree } = getCtx();
    return applyTemplate(tree, data.templatePath, data.targetPath);
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
