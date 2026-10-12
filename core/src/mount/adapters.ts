// Mount adapter registrations — type "mount" context handlers
// Naming: t.mount.{name} — system infrastructure adapters
// Each adapter receives its mount component + MountCtx (not the whole node).

import { registerType } from '#comp';
import { getComponentByName, register } from '#core';
import { KernelError } from '#errors';
import { createMemoryTree, createOverlayTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createRawFsTree } from '#tree/mimefs';
import { createQueryTree } from '#tree/query';
import { queryConfigOf, type QueryConfig } from '#kernel/query';
import { createRepathTree } from '#tree/repath';
import { createModsTree } from './mods';
import { resolveAdapter } from './index';
import { createTypesTree } from './types';

// ── Mount type classes ──

/** Marker type of a node that carries a `#mount` component. */
export class MountPoint {}
registerType('mount-point', MountPoint);

export class MountMongo {
  shared = false;
  uri = '';
  db = 'treenix';
  collection = 'nodes';
  /** Component-namespace boot policy (core-r096): 'rename' auto-migrates bare
   *  component keys at boot, 'stamp' declares the collection's $type-carriers
   *  legitimate data snapshots (e.g. audit before/after). The judgment is
   *  per-collection and human-owned — unset stays fail-closed (throw on dirty;
   *  TREENIX_NS_MIGRATE env is the fleet-wide fallback). */
  nsMigrate?: 'rename' | 'stamp';
}
registerType('t.mount.mongo', MountMongo);

export class MountFs {
  root = '';
  shared = false;
}
registerType('t.mount.fs', MountFs);

export class MountRawFs {
  root = '';
  shared = false;
}
registerType('t.mount.rawfs', MountRawFs);

export class MountMemory {}
registerType('t.mount.memory', MountMemory);

export class MountTypes {}
registerType('t.mount.types', MountTypes);

export class MountMods {}
registerType('t.mount.mods', MountMods);

export class MountQuery implements QueryConfig {
  source = '';
  match: Record<string, unknown> = {};
}
registerType('t.mount.query', MountQuery);

export class MountOverlay {
  layers: string[] = [];
}
registerType('t.mount.overlay', MountOverlay);

// ── Adapters ──

function required(type: string, field: string, at: string): never {
  throw new KernelError('INVALID', `${type} at ${at}: ${field} required`);
}

register(MountMongo, 'mount', async (mount, ctx) => {
  const uri = mount.uri || process.env.MONGO_URI;
  if (!uri) required('t.mount.mongo', 'uri (or MONGO_URI env)', ctx.path);
  const { createMongoTree } = await import('@treenx/mongo');
  const tree = await createMongoTree(uri, mount.db, mount.collection, { nsMigrate: mount.nsMigrate });
  const wrapped = mount.shared ? tree : createRepathTree(tree, ctx.path, '/');


  return wrapped;
});

register(MountTypes, 'mount', (_mount, ctx) => createTypesTree(ctx.parentStore));

register(MountMods, 'mount', () => createModsTree());

register(MountMemory, 'mount', () => createMemoryTree());

// userAuthorable (F4, security/acl.ts): a read-only view over in-tree data —
// the ACL read path plans it with source-R + projection (resolve-plan.ts), so
// node writers (board columns) may author it.
register(MountQuery, 'mount', (mount, ctx) => {
  return createQueryTree(queryConfigOf({ ...mount }, ctx.path), ctx.globalStore || ctx.parentStore);
}, { userAuthorable: true });

register(MountFs, 'mount', async (mount, ctx) => {
  if (!mount.root) required('t.mount.fs', 'root', ctx.path);
  const tree = await createFsTree(mount.root);
  return mount.shared ? tree : createRepathTree(tree, ctx.path, '/');
});

register(MountRawFs, 'mount', async (mount, ctx) => {
  if (!mount.root) required('t.mount.rawfs', 'root', ctx.path);
  // Pass mount path so decoders can resolve self-referential paths in file content
  // (e.g. relative markdown links → absolute outer tree paths).
  const tree = await createRawFsTree(mount.root, mount.shared ? '' : ctx.path);
  return mount.shared ? tree : createRepathTree(tree, ctx.path, '/');
});

register(MountOverlay, 'mount', async (mount, ctx) => {
  if (!mount.layers?.length) required('t.mount.overlay', 'layers', ctx.path);
  const stores: Tree[] = [];
  for (const name of mount.layers) {
    const comp = getComponentByName(ctx.node, name);
    if (!comp) throw new KernelError('INVALID', `t.mount.overlay at ${ctx.path}: layer component "${name}" not found`);
    // Later layers see the base layer as their parent store.
    stores.push(await resolveAdapter(comp, { ...ctx, parentStore: stores[0] ?? ctx.parentStore }));
  }
  // layers[0] is the base; later layers stack on top (last layer = writes).
  let result = stores[0];
  for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
  return result;
});
