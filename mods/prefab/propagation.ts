import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import { assertPrefabPath, prefabInput } from '@treenx/core/mod/prefab-path';
import type { WriteAction, WriteActionContext } from '@treenx/core/kernel/types';
import { mergeFields } from '#prefab/merge';
import { assertChain, fields, readNode, sourceBody, translatedFields } from '#prefab/data';
import { prefabCopy, updatedSource } from '#prefab/source';

/** Decode public action arguments; internal nodes follow the prefab contract. */
function argumentsFor(value: unknown): { target: string; source?: string; field?: string } {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('target' in value) ||
    typeof value.target !== 'string'
  )
    throw new KernelError('INVALID', 'Prefab action requires a target');
  const source = 'source' in value ? value.source : undefined;
  const field = 'field' in value ? value.field : undefined;
  if (
    (source !== undefined && typeof source !== 'string') ||
    (field !== undefined && typeof field !== 'string')
  )
    throw new KernelError('INVALID', 'Prefab source and field must be strings');
  assertPrefabPath(value.target);
  if (source !== undefined) assertPrefabPath(source);
  if (
    field !== undefined &&
    ['$path', '$id', '$rev', '$type', '$v', '$prefab', '$refId'].includes(field)
  )
    throw new KernelError('INVALID', 'Prefab identity cannot be applied or reverted');
  return { target: value.target, source, field };
}

const argumentsSchema = {
  type: 'object',
  properties: { target: { type: 'string' }, source: { type: 'string' }, field: { type: 'string' } },
  required: ['target'],
  additionalProperties: false,
};

/** Copy one source node with a persistent per-field base through the caller's ChangeSet. */
export const instantiate: WriteAction = {
  kind: 'write',
  args: argumentsSchema,
  async handler(ctx, args) {
    const input = argumentsFor(args);
    if (input.source === undefined)
      throw new KernelError('INVALID', 'Prefab instantiation requires a source');
    const source = await readNode(ctx.read, input.source);
    await assertChain(ctx.read, source, input.target);
    try {
      await readNode(ctx.read, input.target);
      throw new KernelError('CONFLICT', 'Prefab target already exists');
    } catch (error) {
      if (!(error instanceof KernelError && error.code === 'NOT_FOUND')) throw error;
    }
    await ctx.requireReadWrite(input.target);
    ctx.change.put(
      prefabCopy(source, input.target, { sourceRoot: input.source, targetRoot: input.target }),
    );
    return { target: input.target };
  },
};

/** Retain the instance's provenance and source revision for one atomic field operation. */
async function instanceSource(ctx: WriteActionContext, target: string) {
  const node = await readNode(ctx.read, target),
    state = node.$prefab;
  if (state === undefined) throw new KernelError('INVALID', 'Node has no prefab provenance');
  const source = await readNode(ctx.read, state.src);
  await assertChain(ctx.read, source, target);
  if (node.$type !== sourceBody(source).$type)
    throw new KernelError('INVALID', 'Prefab source type changed');
  return { node, state, source };
}

/** Propagate unchanged fields and keep each override's previous base in the same atomic write. */
export const pull: WriteAction = {
  kind: 'write',
  args: argumentsSchema,
  async handler(ctx, args) {
    const input = argumentsFor(args),
      { node, state, source } = await instanceSource(ctx, input.target);
    const next = mergeFields(
      fields(node),
      state.base,
      translatedFields(sourceBody(source), state.sourceRoot, state.targetRoot, state.maps),
    );
    if (isDeepStrictEqual(next.value, fields(node)) && isDeepStrictEqual(next.base, state.base))
      return { changed: false };
    const identity = prefabInput(node, node.$path);
    ctx.change.put({
      $path: identity.$path,
      $type: identity.$type,
      $v: identity.$v,
      ...next.value,
      $prefab: { ...state, base: next.base },
    });
    return { changed: true };
  },
};

/** Reset one field to the current source and advance only that field's base. */
export const revert: WriteAction = {
  kind: 'write',
  args: argumentsSchema,
  async handler(ctx, args) {
    const input = argumentsFor(args),
      { node, state, source } = await instanceSource(ctx, input.target);
    if (input.field === undefined)
      throw new KernelError('INVALID', 'Prefab revert requires a field');
    const upstream = translatedFields(
      sourceBody(source),
      state.sourceRoot,
      state.targetRoot,
      state.maps,
    );
    const data = fields(node),
      base = { ...state.base };
    if (Object.hasOwn(upstream, input.field))
      data[input.field] = base[input.field] = upstream[input.field];
    else {
      delete data[input.field];
      delete base[input.field];
    }
    ctx.change.put({
      $path: node.$path,
      $type: node.$type,
      $v: node.$v,
      ...data,
      $prefab: { ...state, base },
    });
    return { field: input.field };
  },
};

/** Apply one instance field back to its source under the caller's own source write rights. */
export const apply: WriteAction = {
  kind: 'write',
  args: argumentsSchema,
  async handler(ctx, args) {
    const input = argumentsFor(args),
      { node, state, source } = await instanceSource(ctx, input.target);
    if (input.field === undefined)
      throw new KernelError('INVALID', 'Prefab apply requires a field');
    const data = fields(sourceBody(source)),
      current = translatedFields(
        node,
        state.targetRoot,
        state.sourceRoot,
        state.maps?.map(({ from, to }) => ({ from: to, to: from })),
      );
    if (Object.hasOwn(current, input.field)) data[input.field] = current[input.field];
    else delete data[input.field];
    ctx.change.put(updatedSource(source, data));
    return { source: source.$path, field: input.field };
  },
};
