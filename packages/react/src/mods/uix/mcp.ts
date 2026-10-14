import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// UIX MCP tools live with the UIX runtime, not with core tree/catalog tools.

export type CompileViewResult = { ok: true; saved?: string } | { ok: false; error: string };

/** UIX actions are supplied by the native module owner. */
export class UixMcpTools {}

export const clientModules = [
  declareOpenModule('@treenx/react/uix/mcp', [], [declareClientType('uix.mcp', UixMcpTools)]),
];

export interface UixMcpTools {
  /** @write @description Verify a UIX view source and optionally save its separate source draft. */
  compile_view(data?: {
    /** @description Source draft path to compile or save. */
    path?: string;
    /** @description Raw UIX source to compile directly. */
    source?: string;
  }): Promise<CompileViewResult>;
}
