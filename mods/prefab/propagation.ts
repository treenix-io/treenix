import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import { assertPrefabPath, prefabInput } from '@treenx/core/mod/prefab-path';
import type { Node, Reader, WriteAction, WriteActionContext } from '@treenx/core/kernel/types';
import { mergeFields } from '#prefab/merge';

export interface PrefabState {
  readonly src: string;
  readonly base: Readonly<Record<string, unknown>>;
  readonly sourceRoot: string;
  readonly targetRoot: string;
}

interface PrefabNode extends Node {
  readonly $prefab?: PrefabState;
}

/** Read through the action's caller rights and retain the source revision as a precondition. */
async function readNode(read: Reader, path: string): Promise<PrefabNode> {
  const copy = (await read.read({ node: path })).copies[0];
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

/** Identity and provenance belong to the copy; they are never propagated as data. */
function fields(node: Node): Record<string, unknown> {
  const { $path, $id, $rev, $type, $v, $refId, $prefab, ...data } = node;
  return data;
}

/** Keep references outside the instance unchanged and map the copied root exactly. */
function translatePath(path: string, from: string, to: string): string {
  if (path === from) return to;
  const prefix = from === '/' ? '/' : `${from}/`;
  if (!path.startsWith(prefix)) return path;
  const suffix = path.slice(prefix.length);
  return to === '/' ? `/${suffix}` : `${to}/${suffix}`;
}

/** Translate only references inside the copied subtree, including references in named components. */
function translate(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => translate(item, from, to));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  const reference: unknown = Reflect.get(value, '$ref');
  const mapped = typeof reference === 'string' && translatePath(reference, from, to) !== reference;
  for (const [name, item] of Object.entries(value)) {
    if (mapped && name === '$refId') continue;
    result[name] =
      mapped && name === '$ref' ? translatePath(reference, from, to) : translate(item, from, to);
  }
  return result;
}

/** Translate node fields without changing their names or retaining copied reference identities. */
function translatedFields(node: Node, from: string, to: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields(node)))
    result[name] = translate(value, from, to);
  const reference = node.$ref;
  if (typeof reference === 'string') {
    result.$ref = translatePath(reference, from, to);
  }
  return result;
}

/** Reject cycles before changing the instance, including chains of variant instances. */
async function assertChain(read: Reader, source: PrefabNode, target: string): Promise<void> {
  const seen = new Set([target]);
  let node = source;
  for (;;) {
    if (seen.has(node.$path)) throw new KernelError('INVALID', 'Prefab chain contains a cycle');
    seen.add(node.$path);
    if (node.$prefab === undefined) return;
    node = await readNode(read, node.$prefab.src);
  }
}

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
    const base = translatedFields(source, input.source, input.target);
    ctx.change.put({
      ...prefabInput(source, input.target),
      ...base,
      $prefab: { src: source.$path, base, sourceRoot: input.source, targetRoot: input.target },
    });
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
  if (node.$type !== source.$type) throw new KernelError('INVALID', 'Prefab source type changed');
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
      translatedFields(source, state.sourceRoot, state.targetRoot),
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
    const upstream = translatedFields(source, state.sourceRoot, state.targetRoot);
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
    const data = fields(source),
      current = translatedFields(node, state.targetRoot, state.sourceRoot);
    if (Object.hasOwn(current, input.field)) data[input.field] = current[input.field];
    else delete data[input.field];
    ctx.change.put({
      $path: source.$path,
      $type: source.$type,
      $v: source.$v,
      ...data,
      ...(source.$prefab === undefined ? {} : { $prefab: source.$prefab }),
    });
    return { source: source.$path, field: input.field };
  },
};
