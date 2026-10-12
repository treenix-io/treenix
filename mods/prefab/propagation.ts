import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import { assertPrefabPath, prefabInput } from '@treenx/core/mod/prefab-path';
import type { WriteAction, WriteActionContext } from '@treenx/core/kernel/types';
import { mergeFields } from '#prefab/merge';
import { assertChain, fields, readNode, sourceBody, translatedFields } from '#prefab/data';
import { prefabCopy, updatedSource } from '#prefab/source';
import { children, markChild, optionalNode, retireBranch } from '#prefab/structure';

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

/** Copy a source subtree in bounded steps, retaining child marks with each accepted copy. */
export const instantiate: WriteAction = {
  kind: 'write',
  args: argumentsSchema,
  async *handler(ctx, args) {
    const input = argumentsFor(args);
    if (input.source === undefined)
      throw new KernelError('INVALID', 'Prefab instantiation requires a source');
    const source = await readNode(ctx.read, input.source);
    await assertChain(ctx.read, source, input.target);
    const existing = await optionalNode(ctx.read, input.target);
    if (existing !== undefined && existing.$prefab?.src !== source.$path)
      throw new KernelError('CONFLICT', 'Prefab target belongs to another source');
    await ctx.requireReadWrite(input.target);
    if (existing === undefined) {
      ctx.change.put(
        prefabCopy(source, input.target, { sourceRoot: input.source, targetRoot: input.target }),
      );
    } else await pullFields(ctx, input.target);
    yield { target: input.target };
    yield* copyChildren(ctx, input.target);
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

/** Advance each node's fields and base together, preserving its structural bookkeeping. */
async function pullFields(ctx: WriteActionContext, target: string) {
  const { node, state, source } = await instanceSource(ctx, target);
  const next = mergeFields(
    fields(node),
    state.base,
    translatedFields(sourceBody(source), state.sourceRoot, state.targetRoot, state.maps),
  );
  if (isDeepStrictEqual(next.value, fields(node)) && isDeepStrictEqual(next.base, state.base))
    return false;
  const identity = prefabInput(node, node.$path);
  ctx.change.put({
    $path: identity.$path,
    $type: identity.$type,
    $v: identity.$v,
    ...next.value,
    $prefab: { ...state, base: next.base },
    ...(node.$prefabChildren === undefined ? {} : { $prefabChildren: node.$prefabChildren }),
  });
  return true;
}

/** Synchronize direct children, recording local deletions before considering source additions. */
async function* copyChildren(ctx: WriteActionContext, root: string) {
  const pending = [root];
  let changed = false;
  for (const target of pending) {
    const parent = await readNode(ctx.read, target);
    const state = parent.$prefab;
    if (state === undefined) throw new KernelError('INVALID', 'Node has no prefab provenance');
    yield { inspected: target };
    const seen = new Set<string>();
    for await (const source of children(ctx.read, state.src)) {
      const name = source.$path.slice(state.src === '/' ? 1 : state.src.length + 1);
      const path = target === '/' ? `/${name}` : `${target}/${name}`;
      seen.add(name);
      const currentParent = await readNode(ctx.read, target);
      const mark = currentParent.$prefabChildren?.[name];
      const own = await optionalNode(ctx.read, path);
      if (own === undefined) {
        if (mark !== undefined) {
          if (mark.removed !== true) {
            await markChild(ctx, currentParent, name, mark.src, true);
            changed = true;
          }
        } else {
          await assertChain(ctx.read, source, path);
          await ctx.requireReadWrite(path);
          ctx.change.put(prefabCopy(source, path, state));
          await markChild(ctx, currentParent, name, source.$path);
          changed = true;
          pending.push(path);
        }
      } else if (own.$prefab?.src === source.$path && mark?.removed !== true) {
        if (mark === undefined) {
          await markChild(ctx, currentParent, name, source.$path);
          changed = true;
        }
        if (await pullFields(ctx, path)) changed = true;
        pending.push(path);
      }
      yield { child: path };
    }

    const currentParent = await readNode(ctx.read, target);
    yield { inspected: target };
    for (const [name, mark] of Object.entries(currentParent.$prefabChildren ?? {})) {
      if (seen.has(name) || mark.removed === true) continue;
      const path = target === '/' ? `/${name}` : `${target}/${name}`;
      const own = await optionalNode(ctx.read, path);
      if (own?.$prefab?.src === mark.src) {
        yield* retireBranch(ctx, path);
      }
      const latest = await readNode(ctx.read, target);
      const marks = { ...latest.$prefabChildren };
      delete marks[name];
      await ctx.requireReadWrite(target);
      ctx.change.patch(target, { $set: { $prefabChildren: marks } });
      changed = true;
      yield { retired: path };
    }
  }
  return changed;
}

/** Pull fields and structure under the editor's rights; each streamed step keeps its own base atomic. */
export const pull: WriteAction = {
  kind: 'write',
  args: argumentsSchema,
  async *handler(ctx, args) {
    const input = argumentsFor(args);
    const changed = await pullFields(ctx, input.target);
    yield { pulled: input.target };
    const structureChanged = yield* copyChildren(ctx, input.target);
    return { changed: changed || structureChanged };
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
      ...(node.$prefabChildren === undefined ? {} : { $prefabChildren: node.$prefabChildren }),
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
