// UIX MCP tools live with the UIX runtime, not with core tree/catalog tools.

import { getComponent } from '@treenx/core';
import { assertSafePath } from '@treenx/core/core/path';
import { getCtx, registerType, setComponent } from '@treenx/core/comp';
import { UixSource, verifyViewSource } from './uix-source';

export type CompileViewResult =
  | { ok: true; saved?: string }
  | { ok: false; error: string };

/** UIX MCP tools for dynamic React views. */
export class UixMcpTools {
  /** @write @description Verify that a UIX view source compiles. With source and path, save it as the view component. */
  async compile_view(data: {
    /** @description View node path to compile when source is omitted, or save target when source is provided. */
    path?: string;
    /** @description Raw UIX source to compile directly. */
    source?: string;
  } = {}): Promise<CompileViewResult> {
    const targetPath = data.path;
    if (targetPath) assertSafePath(targetPath);

    const { tree } = getCtx();
    let code = data.source;

    if (!code) {
      if (!targetPath) return { ok: false, error: 'provide path or source' };
      const node = await tree.get(targetPath);
      if (!node) return { ok: false, error: `not found: ${targetPath}` };
      const view = getComponent(node, UixSource, 'view');
      if (!view?.source) return { ok: false, error: `no uix.source on ${targetPath}` };
      code = view.source;
    }

    const check = verifyViewSource(code);
    if (!check.ok) return check;

    if (data.source && targetPath) {
      const node = await tree.get(targetPath);
      if (!node) return { ok: false, error: `not found: ${targetPath}` };
      setComponent(node, UixSource, { source: data.source }, 'view');
      await tree.set(node);
      return { ok: true, saved: targetPath };
    }

    return check;
  }
}

registerType('uix.mcp', UixMcpTools, { noOptimistic: ['compile_view'] });
