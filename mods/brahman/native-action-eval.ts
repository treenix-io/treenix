import { sourceAction } from '@treenx/core/kernel/source-action';
import type { ActionDef, ModuleManifest } from '@treenx/core/kernel/types';
import { EvalAction } from '#brahman/types';
import { component, runArguments } from '#brahman/native-state';
import { brahmanRunSchema } from '#brahman/native-ports';

/** Execute authored scripts through the existing bounded native action frame. */
export function evalAction(manifest: ModuleManifest): ActionDef {
  return { kind: 'write', args: brahmanRunSchema, io: true, async handler(context, input) {
    const args = runArguments(input);
    const configuration = component(context.node, EvalAction);
    if (configuration.value === '') return;
    const compiled = sourceAction({ type: context.node.$type, module: manifest.id, action: 'run',
      source: configuration.value, draft: context.node.$path, draftRev: context.node.$rev,
      stream: false, definition: { kind: 'write', args: brahmanRunSchema, io: true } }, manifest);
    await compiled.handler!(context, args);
  } };
}
