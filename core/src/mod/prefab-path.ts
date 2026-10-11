import { assertSafePath } from '#core/path';
import { KernelError } from '#errors';
import type { Node, NodeInput } from '#kernel/types';

/** Copy prefab data without reusing captured instance identity or revision. */
export function prefabInput(node: NodeInput | Node, path: string): NodeInput {
  const { $id, $rev, $refId, $path, ...fields } = node;
  return { ...fields, $path: path };
}

/** Resolve a prefab address using its explicit deployment target and absolute-path permission. */
export function resolvePrefabPath(nodePath: string, target: string, allowAbsolute = false): string {
  assertPrefabPath(target);
  if (nodePath.startsWith('/') && !allowAbsolute)
    throw new KernelError('INVALID', 'Absolute prefab path requires allowAbsolute');
  const path = nodePath === '.' ? target : nodePath.startsWith('/') ? nodePath
    : target === '/' ? `/${nodePath}` : `${target}/${nodePath}`;
  assertPrefabPath(path);
  return path;
}

/** Give malformed deployment paths a transport-independent refusal. */
export function assertPrefabPath(path: string): void {
  try { assertSafePath(path); }
  catch (error) { throw new KernelError('INVALID', error instanceof Error ? error.message : String(error)); }
}
