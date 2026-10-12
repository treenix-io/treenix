import { KernelError } from '@treenx/core/errors';
import type { Reader, WriteAction } from '@treenx/core/kernel/types';
import type { NativePrefabSource } from '@treenx/core/mod/native-prefab';
import { prefabInput, resolvePrefabPath } from '@treenx/core/mod/prefab-path';

interface DeployArguments {
  readonly target: string;
  readonly allowAbsolute?: boolean;
}

/** Decode deployment arguments received at the public action boundary. */
function deployArguments(value: unknown): DeployArguments {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('target' in value) ||
    typeof value.target !== 'string'
  )
    throw new KernelError('INVALID', 'Prefab deployment requires a target path');
  const allowAbsolute = 'allowAbsolute' in value ? value.allowAbsolute : undefined;
  if (allowAbsolute !== undefined && typeof allowAbsolute !== 'boolean')
    throw new KernelError('INVALID', 'Absolute-path permission must be boolean');
  return { target: value.target, allowAbsolute };
}

/** Consume only the absence needed for copy-if-absent; all other read refusals propagate. */
async function exists(read: Reader, path: string): Promise<boolean> {
  try {
    const copy = (await read.read({ node: path })).copies[0];
    if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
    return true;
  } catch (error) {
    if (error instanceof KernelError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

export const deployPrefabAction: WriteAction = {
  kind: 'write',
  args: {
    type: 'object',
    properties: { target: { type: 'string' }, allowAbsolute: { type: 'boolean' } },
    required: ['target'],
    additionalProperties: false,
  },
  /** Copy accepted source data in one atomic caller-authorized decision. */
  async handler(this: NativePrefabSource, ctx, args) {
    const input = deployArguments(args);
    const nodes = this.nodes.map((node) =>
      prefabInput(node, resolvePrefabPath(node.$path, input.target, input.allowAbsolute)),
    );
    const deployed: string[] = [],
      skipped: string[] = [];
    const seen = new Set<string>();

    for (const node of nodes) {
      if (seen.has(node.$path)) {
        skipped.push(node.$path);
        continue;
      }
      seen.add(node.$path);
      if (await exists(ctx.read, node.$path)) {
        skipped.push(node.$path);
        continue;
      }
      await ctx.requireReadWrite(node.$path);
      ctx.change.put(node);
      deployed.push(node.$path);
    }

    return { deployed, skipped };
  },
};
