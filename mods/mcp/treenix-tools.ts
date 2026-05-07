// Treenix MCP tool node — legacy tree/discovery tools as ordinary node actions.

import { createNode, getComponent } from '@treenx/core';
import { getCtx, registerActions } from '@treenx/core/comp';
import { UixSource, verifyViewSource } from '@treenx/core/mods/uix/uix-source';
import { assertSafePath } from '@treenx/core/core/path';
import { TypeCatalog } from '@treenx/core/schema/catalog';
import { executeAction } from '@treenx/core/server/actions';
import { deployPrefab } from '@treenx/core/server/prefab';
import { formatCatalog, yaml } from './mcp-server';
import { TreenixMcpTools } from './treenix-tool-types';

const catalog = new TypeCatalog();

function dataKeys(node: Record<string, unknown>) {
  return Object.keys(node).filter(k => !k.startsWith('$'));
}

/** Treenix tree and type-catalog tools exposed through the generic MCP adapter. */
class TreenixMcpToolsServer extends TreenixMcpTools {
  /** Read a node by path. Returns full untruncated values. */
  async get_node(data: { path: string }) {
    assertSafePath(data.path); // R5-MCP-3
    const { tree } = getCtx();
    let node;
    try {
      node = await tree.get(data.path);
    } catch (err) {
      // ACL deny is masked as not-found to avoid leaking existence to unauthorized callers,
      // but log it so ops can see real authorization failures.
      if ((err as { code?: string }).code === 'FORBIDDEN') {
        console.error(`[mcp] get_node FORBIDDEN at ${data.path}:`, err);
        return `not found: ${data.path}`;
      }
      throw err;
    }
    return node ? yaml(node, 0, Infinity) : `not found: ${data.path}`;
  }

  /** List children of a node. Long string values may be truncated; use get_node for full data. */
  async list_children(data: { path: string; depth?: number; detail?: boolean; full?: boolean }) {
    assertSafePath(data.path); // R5-MCP-3
    const { tree } = getCtx();
    const result = await tree.getChildren(data.path, { depth: data.depth });
    const { items, total, truncated } = result;
    const truncNote = truncated ? '\n⚠️ Results truncated — ACL scan limit reached. Use query mounts for large collections.' : '';

    if (data.full) return yaml({ total, truncated, items });

    if (data.detail) {
      const lines = items.map(n => {
        const name = n.$path.split('/').at(-1);
        const keys = dataKeys(n);
        const header = n.$type === 'dir' ? `${name}/` : `${name}: ${n.$type}  [${keys.length}]`;
        const fields = keys.map(k => {
          const v = (n as Record<string, unknown>)[k];
          if (v && typeof v === 'object' && '$type' in (v as object))
            return `  ${k}: ${(v as Record<string, unknown>).$type}`;
          if (Array.isArray(v)) return `  ${k}: [${v.length}]`;
          const s = String(v);
          return `  ${k}: ${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
        });
        return header + (fields.length ? '\n' + fields.join('\n') : '');
      });
      return lines.join('\n') + `\n(${total} total)` + truncNote;
    }

    const lines = items.map(n => {
      const name = n.$path.split('/').at(-1);
      if (n.$type === 'dir') return `${name}/`;
      return `${name}  ${n.$type}  [${dataKeys(n).length}]`;
    });
    return lines.join('\n') + (total > items.length ? `\n(${total} total)` : '') + truncNote;
  }

  /** Create or update a node. May require Guardian approval. */
  async set_node(data: {
    path: string;
    type: string;
    components?: Record<string, unknown>;
    acl?: Array<{ g: string; p: number }>;
    owner?: string;
  }) {
    assertSafePath(data.path); // R5-MCP-3
    const { tree } = getCtx();
    const existing = await tree.get(data.path);
    const node = existing ?? createNode(data.path, data.type);
    if (!existing) node.$type = data.type;
    if (data.components) {
      for (const [k, v] of Object.entries(data.components)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        const comp = v as Record<string, unknown> | null;
        if (comp && typeof comp === 'object' && comp.$type === data.type) {
          for (const [fk, fv] of Object.entries(comp)) {
            if (fk !== '$type') node[fk] = fv;
          }
          continue;
        }
        node[k] = v;
      }
    }
    if (data.acl) node.$acl = data.acl;
    if (data.owner) node.$owner = data.owner;
    await tree.set(node);
    return yaml(node);
  }

  /** Execute an action on a node or component. Actions are methods registered on types. May require Guardian approval. */
  async execute(data: { path: string; action: string; type?: string; key?: string; data?: Record<string, unknown> }) {
    assertSafePath(data.path); // R5-MCP-3
    const { tree, userId, claims } = getCtx();
    const result = await executeAction(tree, data.path, data.type, data.key, data.action, data.data, {
      userId: userId as string | null | undefined,
      claims: claims as string[] | undefined,
    });
    return yaml(result ?? { ok: true });
  }

  /** Deploy a module prefab to a target path. Idempotent: skips existing nodes. */
  async deploy_prefab(data: { source: string; target: string; allowAbsolute?: boolean }) {
    assertSafePath(data.source); // R5-MCP-3
    assertSafePath(data.target);
    const { tree } = getCtx();
    return yaml(await deployPrefab(tree, data.source, data.target, { allowAbsolute: data.allowAbsolute }));
  }

  /** Verify that a UIX view source compiles correctly. */
  async compile_view(data: { path?: string; source?: string }) {
    if (data.path) assertSafePath(data.path); // R5-MCP-3
    const { tree } = getCtx();
    let code = data.source;
    if (!code) {
      if (!data.path) return 'error: provide path or source';
      const node = await tree.get(data.path);
      if (!node) return `not found: ${data.path}`;
      const view = getComponent(node, UixSource, 'view');
      if (!view?.source) return `no uix.source on ${data.path}`;
      code = view.source;
    }
    return yaml(verifyViewSource(code));
  }

  /** Remove a node by path. May be denied by Guardian. */
  async remove_node(data: { path: string }) {
    assertSafePath(data.path); // R5-MCP-3
    const { tree } = getCtx();
    const ok = await tree.remove(data.path);
    return ok ? `removed: ${data.path}` : `not found: ${data.path}`;
  }

  /** List all registered types with compact descriptions plus property/action docs. */
  catalog() {
    return formatCatalog(catalog.list());
  }

  /** Get full schema of a type: properties, actions, and cross-references. */
  describe_type(data: { type: string }) {
    const desc = catalog.describe(data.type);
    return desc ? yaml(desc) : `type not found: ${data.type}`;
  }

  /** Search types by keyword across names, titles, property names, and action names. */
  search_types(data: { query: string }) {
    return formatCatalog(catalog.search(data.query));
  }
}

registerActions('mcp.treenix', TreenixMcpToolsServer, {
  override: true,
  noOptimistic: ['set_node', 'execute', 'deploy_prefab', 'remove_node'],
});
