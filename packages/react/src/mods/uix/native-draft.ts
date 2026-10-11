import { KernelError } from '@treenx/core/errors';
import type { ActionDef, Node, WriteActionContext } from '@treenx/core/kernel/types';
import { verifyViewSource } from './uix-source';
import type { CompileViewResult } from './mcp';

/** Read one actual draft through the caller's projection, preserving malformed-copy errors. */
async function readDraft(context: WriteActionContext, path: string): Promise<Node> {
  const result = await context.read.read({ node: path });
  const copy = result.copies[0];
  if ('error' in copy) throw copy.error;
  if (copy.node.$type !== 'uix.source') throw new KernelError('INVALID', 'A separate source draft is required');
  return copy.node;
}

/** Verify agent source and save only its editable draft; publication remains a separate admin action. */
async function compileDraft(context: WriteActionContext, input: unknown): Promise<CompileViewResult> {
  if (typeof input !== 'object' || input === null) throw new KernelError('INVALID', 'Draft arguments must be an object');
  const path = 'path' in input ? input.path : undefined;
  const source = 'source' in input ? input.source : undefined;
  if (path !== undefined && typeof path !== 'string' || source !== undefined && typeof source !== 'string')
    throw new KernelError('INVALID', 'Draft path and source must be strings');

  let code = source;
  if (code === undefined) {
    if (path === undefined) throw new KernelError('INVALID', 'A draft path or source is required');
    const draft = await readDraft(context, path);
    if (typeof draft.source !== 'string') throw new KernelError('INVALID', 'Malformed source draft');
    code = draft.source;
  }
  const result = verifyViewSource(code);
  if (!result.ok || source === undefined || path === undefined) return result;

  await readDraft(context, path);
  await context.requireReadWrite(path);
  context.change.patch(path, { $set: { source } });
  return { ok: true, saved: path };
}

export const compileDraftAction: ActionDef = {
  kind: 'write',
  args: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, source: { type: 'string' } } },
  handler: compileDraft,
};

/** Publication verifies the readable draft through its actual module's native read action. */
export const verifyDraftAction: ActionDef = {
  kind: 'read', args: { type: 'object', additionalProperties: false },
  async handler(context) {
    if (typeof context.node.source !== 'string') throw new KernelError('INVALID', 'Malformed source draft');
    const result = verifyViewSource(context.node.source);
    if (!result.ok) throw new KernelError('INVALID', result.error);
  },
};
