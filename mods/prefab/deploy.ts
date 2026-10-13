import { KernelError } from '@treenx/core/errors';
import type { WriteAction } from '@treenx/core/kernel/types';
import { resolvePrefabPath } from '@treenx/core/mod/prefab-path';
import { readNode, sourceBody, SOURCE_TYPE, type PrefabCatalog } from '#prefab/data';
import { prefabCopy, sourceMaps, sourceRecords } from '#prefab/source';
import { children, markChild, optionalNode } from '#prefab/structure';

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

export const deployPrefabAction: WriteAction = {
  kind: 'write',
  args: {
    type: 'object',
    properties: { target: { type: 'string' }, allowAbsolute: { type: 'boolean' } },
    required: ['target'],
    additionalProperties: false,
  },
  /** Materialize inert sources, then copy accepted records in caller-authorized bounded steps. */
  async *handler(this: PrefabCatalog, ctx, args) {
    const input = deployArguments(args);
    const catalog = ctx.node.$path;
    const deployed: string[] = [],
      skipped: string[] = [];
    for (const node of this.nodes) {
      const path = resolvePrefabPath(node.$path, input.target, input.allowAbsolute);
      if ((await optionalNode(ctx.read, path)) === undefined) await ctx.requireReadWrite(path);
    }

    if (this.materialized !== true) {
      for (const record of sourceRecords(catalog, this.nodes)) {
        if ((await optionalNode(ctx.read, record.$path)) === undefined) {
          await ctx.requireReadWrite(record.$path);
          ctx.change.put(record);
        }
        yield { source: record.$path };
      }
      ctx.change.patch(catalog, { $set: { materialized: true } });
      yield { source: catalog };
    }

    const state = {
      sourceRoot: `${catalog}/source/relative`,
      targetRoot: input.target,
      maps: sourceMaps(catalog, input.target),
      catalog,
    };
    for (const branch of ['relative', 'absolute']) {
      const root = `${catalog}/source/${branch}`;
      if ((await optionalNode(ctx.read, root)) === undefined) continue;
      const pending = [root];
      for (const address of pending) {
        const source = await readNode(ctx.read, address);
        if (source.$type !== SOURCE_TYPE)
          throw new KernelError('INVALID', 'Prefab source tree requires inert records');
        const body = sourceBody(source);
        const path = resolvePrefabPath(body.$path, input.target, input.allowAbsolute);
        // The synthetic absolute root indexes source children; it is not a deployment destination.
        if (source.implicit === true && path === '/') {
          for await (const child of children(ctx.read, source.$path)) {
            pending.push(child.$path);
            yield { source: child.$path };
          }
          continue;
        }
        const own = await optionalNode(ctx.read, path);
        if (own === undefined) {
          const separator = path.lastIndexOf('/');
          const parent =
            path === '/'
              ? undefined
              : await optionalNode(ctx.read, path.slice(0, separator) || '/');
          const name = path.slice(separator + 1);
          const mark = parent?.$prefabChildren?.[name];
          if (mark !== undefined) {
            if (parent !== undefined && mark.removed !== true)
              await markChild(ctx, parent, name, mark.src, true);
            if (source.implicit !== true) skipped.push(path);
          } else {
            await ctx.requireReadWrite(path);
            ctx.change.put(prefabCopy(source, path, state));
            if (parent !== undefined) await markChild(ctx, parent, name, source.$path);
            if (source.implicit !== true) deployed.push(path);
          }
        } else if (source.implicit !== true) skipped.push(path);
        yield { target: path };
        for await (const child of children(ctx.read, source.$path)) {
          pending.push(child.$path);
          yield { source: child.$path };
        }
      }
    }
    return { deployed, skipped };
  },
};
