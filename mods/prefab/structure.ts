import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import type { Reader, WriteActionContext } from '@treenx/core/kernel/types';
import { fields, readNode, type PrefabChildren, type PrefabNode } from '#prefab/data';

/** Keep absence distinct from a refused read, including when marking a locally removed child. */
export async function optionalNode(read: Reader, path: string): Promise<PrefabNode | undefined> {
  try {
    return await readNode(read, path);
  } catch (error) {
    if (error instanceof KernelError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

/** Page direct children so the caller can commit or yield between bounded reads. */
export async function* children(read: Reader, path: string): AsyncGenerator<PrefabNode> {
  let after: string | undefined;
  do {
    const result = await read.read({ children: path, window: { limit: 1, after } });
    for (const copy of result.copies) {
      if ('error' in copy)
        throw new KernelError(copy.error.code, `Prefab children ${path}: ${copy.error.message}`);
      yield copy.node;
    }
    after = result.next;
  } while (after !== undefined);
}

/** A parent's mark survives the deletion of its child and remains in the instance's domain. */
export function childMarks(
  parent: PrefabNode,
  name: string,
  src: string,
  removed = false,
): PrefabChildren {
  return {
    ...parent.$prefabChildren,
    [name]: { src, ...(removed ? { removed: true } : {}) },
  };
}

/** Change the mark in the same atomic step as creating or removing the corresponding child. */
export async function markChild(
  ctx: WriteActionContext,
  parent: PrefabNode,
  name: string,
  src: string,
  removed = false,
): Promise<void> {
  await ctx.requireReadWrite(parent.$path);
  ctx.change.patch(parent.$path, {
    $set: { $prefabChildren: childMarks(parent, name, src, removed) },
  });
}

/** Keep a locally changed branch; delete an unchanged source branch from its leaves in bounded steps. */
export async function* retireBranch(ctx: WriteActionContext, path: string) {
  const pending = [path],
    records: PrefabNode[] = [];
  let overridden = false;
  for (const current of pending) {
    const node = await readNode(ctx.read, current);
    records.push(node);
    if (node.$prefab === undefined || !isDeepStrictEqual(fields(node), node.$prefab.base))
      overridden = true;
    yield { inspected: current };
    const seen = new Set<string>();
    for await (const child of children(ctx.read, current)) {
      const name = child.$path.slice(current === '/' ? 1 : current.length + 1);
      seen.add(name);
      if (node.$prefabChildren?.[name]?.src !== child.$prefab?.src) overridden = true;
      pending.push(child.$path);
      yield { inspected: child.$path };
    }
    for (const name of Object.keys(node.$prefabChildren ?? {}))
      if (!seen.has(name)) overridden = true;
  }

  for (const observed of records.reverse()) {
    const node = await readNode(ctx.read, observed.$path);
    if (node.$rev !== observed.$rev)
      throw new KernelError('CONFLICT', 'Prefab branch changed during propagation');
    if (overridden)
      ctx.change.patch(node.$path, { $unset: { $prefab: true, $prefabChildren: true } });
    else ctx.change.remove(node.$path);
    yield { [overridden ? 'detached' : 'removed']: node.$path };
  }
}
