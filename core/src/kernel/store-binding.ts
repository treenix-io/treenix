import { assertSafePath } from '#core/path';
import { KernelError } from '#errors';
import { decodeChainNode } from '#kernel/chain-index';
import type { ChainNode } from '#kernel/rights';
import { createMountIdentity } from '#kernel/mount-identity';
import { positionToRev } from '#kernel/position';
import type { Node, NodeId, Path, StoreBinding, StoredNode } from '#kernel/types';

export interface StoreBindingSources {
  readonly lower: StoredNode | null;
  readonly upper: StoredNode | null;
}

/** Canonical physical bodies stay private to the operation that admitted both source reads. */
export function createStoreBindingOwner(
  origin: string,
  declaration: Node,
  component: string,
  binding: StoreBinding,
) {
  assertSafePath(binding.path);
  assertSafePath(binding.lower);
  assertSafePath(binding.upper);
  const identity = createMountIdentity('s', origin, declaration.$id, component);
  const aliases = new Map<NodeId, Path>();
  const hiddenAliases = new Map<NodeId, Set<Path>>();
  const physicalAliases = new Map<Path, { id: NodeId; path: Path; visible: boolean }>();
  const future = new Map<Path, ChainNode | null>();

  function input(node: StoredNode): Node;
  function input(node: null): null;
  function input(node: StoredNode | null): Node | null;
  function input(node: StoredNode | null): Node | null {
    if (node === null) return null;
    const { $pos, $acl, $owner, ...fields } = node;
    return { ...fields, $rev: positionToRev($pos) };
  }

  function relative(path: Path, root: Path): string {
    assertSafePath(path);
    if (path === root) return '';
    if (!path.startsWith(root === '/' ? '/' : `${root}/`))
      throw new KernelError('INVALID', 'Store binding path leaves its declared range');
    return path.slice(root === '/' ? 0 : root.length);
  }

  function at(root: Path, suffix: string): Path {
    return `${root === '/' ? '' : root}${suffix}` || '/';
  }

  function select(sources: StoreBindingSources) {
    return binding.select(input(sources.lower), input(sources.upper));
  }

  function projectStaged(path: Path, sources: StoreBindingSources): StoredNode | null {
    const selected = select(sources);
    if (selected === null || selected.node === null) return null;
    const physical = selected.source === 'lower' ? sources.lower : sources.upper;
    if (physical === null)
      throw new KernelError('INVALID', 'Store binding selected an absent physical source');
    if (selected.baseId !== null && sources.lower?.$id !== selected.baseId)
      throw new KernelError('INVALID', 'Store binding lost its lower source identity');
    if (selected.source === 'lower' && selected.baseId === null)
      throw new KernelError('INVALID', 'Store binding lower identity is absent');
    if (Object.hasOwn(selected.node, '$acl') || Object.hasOwn(selected.node, '$owner'))
      throw new KernelError('INVALID', 'Protected metadata cannot enter a Store binding body');
    const sourceId = selected.baseId ?? physical.$id;
    const id = sourceId.startsWith('p:') ? `p:${path}` : identity.id(sourceId);
    return {
      ...selected.node,
      $path: path,
      $id: id,
      $pos: sources.upper?.$pos ?? physical.$pos,
      ...(sources.upper?.$acl === undefined ? {} : { $acl: sources.upper.$acl }),
      ...(sources.upper?.$owner === undefined ? {} : { $owner: sources.upper.$owner }),
    };
  }

  /** Accepted aliases expose one location while the physical sources retain their canonical identities. */
  function project(path: Path, sources: StoreBindingSources): StoredNode | null {
    const node = projectStaged(path, sources);
    if (node === null) return null;
    const accepted = aliases.get(node.$id);
    if (
      (accepted !== undefined && accepted !== path) ||
      (accepted === undefined && hiddenAliases.has(node.$id))
    )
      return null;
    return node;
  }

  /** Accepted upper metadata restores aliases before a node principal can open its lane. */
  function forget(physicalPath: Path): void {
    const logicalPath = at(binding.path, relative(physicalPath, binding.upper));
    future.delete(logicalPath);
    const previous = physicalAliases.get(physicalPath);
    if (previous !== undefined) {
      if (previous.visible) aliases.delete(previous.id);
      else {
        const paths = hiddenAliases.get(previous.id)!;
        paths.delete(previous.path);
        if (paths.size === 0) hiddenAliases.delete(previous.id);
      }
    }
    physicalAliases.delete(physicalPath);
  }

  function remember(upper: StoredNode | null, physicalPath: Path): void {
    if (upper === null) return;
    const selected = binding.describe(input(upper));
    if (selected === null) return;
    const path = at(binding.path, relative(physicalPath, binding.upper));
    const source = selected.baseId ?? upper.$id;
    const id = source.startsWith('p:') ? `p:${path}` : identity.id(source);
    const visible = selected.node !== null;
    if (visible) {
      const prior = aliases.get(id);
      if (prior !== undefined && prior !== path)
        throw new KernelError('INVALID', 'Store binding duplicates a logical identity');
      aliases.set(id, path);
    } else {
      let paths = hiddenAliases.get(id);
      if (paths === undefined) {
        paths = new Set();
        hiddenAliases.set(id, paths);
      }
      paths.add(path);
    }
    physicalAliases.set(physicalPath, { id, path, visible });
    future.set(
      path,
      selected.node === null
        ? null
        : decodeChainNode({
            ...selected.node,
            $path: path,
            $id: id,
            ...(upper.$acl === undefined ? {} : { $acl: upper.$acl }),
            ...(upper.$owner === undefined ? {} : { $owner: upper.$owner }),
          }),
    );
  }

  function accept(upper: StoredNode | null, path: Path): void {
    forget(path);
    remember(upper, path);
  }

  function acceptBatch(
    changes: readonly { readonly node: StoredNode | null; readonly path: Path }[],
  ): void {
    for (const change of changes) forget(change.path);
    for (const change of changes) remember(change.node, change.path);
  }

  function address(id: NodeId, physical: Path | undefined): Path | undefined {
    const accepted = aliases.get(id);
    if (accepted !== undefined) return accepted;
    const hidden = hiddenAliases.get(id)?.values().next().value;
    if (hidden !== undefined) return hidden;
    if (physical === undefined) return undefined;
    for (const root of [binding.lower, binding.upper]) {
      if (physical === root || physical.startsWith(root === '/' ? '/' : `${root}/`))
        return at(binding.path, relative(physical, root));
    }
    return undefined;
  }

  return {
    binding,
    identity,
    select,
    project,
    projectStaged,
    accept,
    acceptBatch,
    address,
    metadata: (path: Path) => future.get(path),
    sources(path: Path, root: Path) {
      const suffix = relative(path, root);
      return { lower: at(binding.lower, suffix), upper: at(binding.upper, suffix) };
    },
  };
}
