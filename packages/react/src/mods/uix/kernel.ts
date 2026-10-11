import { registerType } from '@treenx/core/comp';
import { registerKernel, registerKernelAction } from '@treenx/core/kernel';
import { A, R, W, type RuleInput } from '@treenx/core/kernel/types';
import { UixSource } from './uix-source';
import { compileDraftAction, verifyDraftAction } from './native-draft';

/** Administrator-owned immutable snapshot, separate from its ordinary editable source draft. */
class UixPublication {
  type = '';
  module = '';
  source = '';
  draft = '';
  draftRev = '';
}

class UixActionPublication extends UixPublication {
  action = '';
  definition = {};
  stream = false;
}

/** Native action metadata binds directly to the draft owner, preserving the retiring legacy class. */
class NativeUixMcpTools {}

/** Published source is readable, while only the instance administrator may replace it. */
function publicationRights(input: RuleInput): number {
  return input.admin ? R | W | A : R;
}

registerType('uix.source', UixSource);
registerType('uix.publication', UixPublication);
registerType('uix.action-publication', UixActionPublication);
registerType('uix.mcp', NativeUixMcpTools);
registerKernel(UixPublication, 'acl', publicationRights);
registerKernel(UixActionPublication, 'acl', publicationRights);
registerKernelAction(NativeUixMcpTools, 'compile_view', compileDraftAction);
registerKernelAction(UixSource, 'verify_view', verifyDraftAction);
