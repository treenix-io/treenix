import { KernelError } from '#errors';
import type { Node, Registry, StoredNode, WriteActionContext, PublishedView } from '#kernel/types';

export const PUBLICATION_PREFIX = '/sys/uix-publication.';

/** Decode the persisted publication boundary loudly before installing its owning generation. */
export function publishedView(node: Node | StoredNode): PublishedView {
  if (
    node.$type !== 'uix.publication' ||
    typeof node.type !== 'string' ||
    typeof node.module !== 'string' ||
    typeof node.source !== 'string' ||
    typeof node.draft !== 'string' ||
    typeof node.draftRev !== 'string' ||
    node.$path !== `${PUBLICATION_PREFIX}${node.type}`
  )
    throw new KernelError('INVALID', 'Malformed view publication');

  return {
    type: node.type,
    module: node.module,
    source: node.source,
    draft: node.draft,
    draftRev: node.draftRev,
  };
}

/** Publish only the accepted immutable snapshot, preserving every other owning module declaration. */
export function installPublishedView(registry: Registry, view: PublishedView): void {
  const type = registry.type(view.type);
  if (type.module !== view.module)
    throw new KernelError('FORBIDDEN', 'Publication owner differs from type owner');
  const manifest = registry.module(view.module);
  registry.publish({ ...manifest, views: { ...manifest.views, [view.type]: view } });
}

/** Snapshot a readable draft and update its ownership locator in the same administrator-authorized commit. */
export async function publishView(context: WriteActionContext, args: unknown): Promise<void> {
  await context.requireAdmin();
  if (
    typeof args !== 'object' ||
    args === null ||
    !('draft' in args) ||
    typeof args.draft !== 'string'
  )
    throw new KernelError('INVALID', 'A draft path is required');
  const type = context.node.name;
  const module = context.node.module;
  if (typeof type !== 'string' || typeof module !== 'string')
    throw new KernelError('INVALID', 'Malformed type ownership');
  const result = await context.read.read({ node: args.draft });
  const copy = result.copies[0];
  if ('error' in copy) throw copy.error;
  const draft = copy.node;
  if (draft.$type !== 'uix.source' || typeof draft.source !== 'string')
    throw new KernelError('INVALID', 'A source draft is required');
  await context.act({ path: draft.$path, action: 'verify_view', args: {} });
  const path = `${PUBLICATION_PREFIX}${type}`;
  await context.requireReadWrite(path);
  context.change.put({
    $path: path,
    $type: 'uix.publication',
    type,
    module,
    source: draft.source,
    draft: draft.$path,
    draftRev: draft.$rev,
  });
  context.change.patch(context.node.$path, { $set: { viewPublication: path } });
}
