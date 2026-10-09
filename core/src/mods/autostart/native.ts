import { createNode, isRef, register } from '#core';
import { assertSafePath } from '#core/path';
import { KernelError } from '#errors';
import { registerKernelAction } from '#kernel/manifest';
import type { WriteActionContext } from '#kernel/types';
import type { TypeSchema } from '#schema/types';
import autostartSchema from './schemas/autostart.json';

const schema: TypeSchema = { ...autostartSchema, type: 'object' };
const { name: _startArgumentName, ...startArgument } = autostartSchema.methods.start.arguments[0];
const { name: _stopArgumentName, ...stopArgument } = autostartSchema.methods.stop.arguments[0];

/** Registers the schema-backed native caller actions for autostart. */
export function registerNativeAutostart(): void {
  register('autostart', 'schema', () => schema);
  registerKernelAction('autostart', 'start', {
    kind: 'write',
    args: { ...startArgument, type: 'object' },
    handler: nativeStart,
  });
  registerKernelAction('autostart', 'stop', {
    kind: 'write',
    args: { ...stopArgument, type: 'object' },
    handler: nativeStop,
  });
}

/** Writes the caller-owned ref that requests a service start. */
async function nativeStart(ctx: WriteActionContext, input: unknown): Promise<void> {
  const path = servicePath(input);
  const refPath = refPathFor(ctx.node.$path, path);
  await ctx.requireReadWrite(refPath);

  try {
    const copy = (await ctx.read.read({ node: refPath })).copies[0];
    if ('error' in copy) throw copy.error;
    if (!isRef(copy.node) || copy.node.$ref !== path)
      throw new KernelError('CONFLICT', 'Autostart ref address is occupied');
    return;
  } catch (error) {
    if (!(error instanceof KernelError) || error.code !== 'NOT_FOUND') throw error;
  }

  const ref = createNode(refPath, 'ref', { $ref: path });
  ctx.change.put({ $path: ref.$path, $type: ref.$type, $ref: ref.$ref });
}

/** Removes the caller-owned ref that requests a service stop. */
async function nativeStop(ctx: WriteActionContext, input: unknown): Promise<void> {
  const path = servicePath(input);
  const refPath = refPathFor(ctx.node.$path, path);
  await ctx.requireReadWrite(refPath);

  const copy = (await ctx.read.read({ node: refPath })).copies[0];
  if ('error' in copy) throw copy.error;
  if (!isRef(copy.node) || copy.node.$ref !== path)
    throw new KernelError('NOT_FOUND', 'Autostart service is not registered');

  ctx.change.remove(refPath);
}

/** Validates the caller's requested service path at the action boundary. */
function servicePath(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('path' in input) || typeof input.path !== 'string')
    throw new KernelError('INVALID', 'Service path is required');

  try {
    assertSafePath(input.path);
  } catch (error) {
    console.error(error);
    throw new KernelError('INVALID', 'Invalid service path');
  }
  if (input.path === '/') throw new KernelError('INVALID', 'Invalid service path');

  return input.path;
}

/** Preserves the existing autostart child naming rule. */
function refPathFor(autostartPath: string, servicePath: string): string {
  return `${autostartPath}/${servicePath.slice(1).replaceAll('/', '-')}`;
}
