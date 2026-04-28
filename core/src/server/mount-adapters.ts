// Mount adapter registrations — type "mount" context handlers
// Naming: t.mount.{name} — system infrastructure adapters
// Each adapter receives its mount component + MountCtx (not the whole node).

import { createTrpcTransport } from '#client';
import { registerType } from '#comp';
import { isComponent, type NodeData, register, resolve } from '#core';
import { createMemoryTree, createOverlayTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createRawFsStore } from '#tree/mimefs';
import { createQueryTree, type QueryConfig } from '#tree/query';
import { createRepathTree } from '#tree/repath';
import { createModsStore } from './mods-mount';
import { createTypesStore } from './types-mount';

export type MountCtx = {
  node: NodeData;
  path: string;
  parentStore: Tree;
  globalStore?: Tree;
};

export type MountAdapter<T = unknown> = (mount: T, ctx: MountCtx) => Tree | Promise<Tree>;

declare module '#core/context' {
  interface ContextHandlers<T> {
    mount: MountAdapter<T>;
  }
}

// ── Mount type classes ──

export class MountPoint {
  disabled = false;
}
registerType('mount-point', MountPoint);

export class MountMongo {
  shared = false;
  uri = '';
  db = 'treenix';
  collection = 'nodes';
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

export class MountTreeTrpc {
  url = '';
  path = '/';
  token = '';
}
registerType('t.mount.tree.trpc', MountTreeTrpc);

// ── Adapters ──

register(MountMongo, 'mount', async (mount, ctx) => {
  const uri = mount.uri || process.env.MONGO_URI;
  if (!uri) throw new Error('t.mount.mongo: no uri and MONGO_URI not set');
  const { createMongoTree } = await import('@treenx/mongo');
  const tree = await createMongoTree(uri, mount.db, mount.collection);
  return mount.shared ? tree : createRepathTree(tree, ctx.path, '/');
});

register(MountTypes, 'mount', (_mount, ctx) => createTypesStore(ctx.parentStore));

register(MountMods, 'mount', (_mount, ctx) => createModsStore(ctx.parentStore));

register(MountMemory, 'mount', () => createMemoryTree());

register(MountQuery, 'mount', (mount, ctx) => {
  if (!mount.source || !mount.match) throw new Error('t.mount.query: source and match required');
  return createQueryTree(mount, ctx.globalStore || ctx.parentStore);
});

register(MountFs, 'mount', async (mount, ctx) => {
  if (!mount.root) throw new Error('t.mount.fs: root required');
  const tree = await createFsTree(mount.root);
  return mount.shared ? tree : createRepathTree(tree, ctx.path, '/');
});

register(MountRawFs, 'mount', async (mount, ctx) => {
  if (!mount.root) throw new Error('t.mount.rawfs: root required');
  // Pass mount path so decoders can resolve self-referential paths in file content
  // (e.g. relative markdown links → absolute outer tree paths).
  const tree = await createRawFsStore(mount.root, mount.shared ? '' : ctx.path);
  return mount.shared ? tree : createRepathTree(tree, ctx.path, '/');
});

// Federation: mount a remote Treenix instance's tree via tRPC.
// F18: reject private/internal IP ranges to prevent SSRF via mount creation.
const PRIVATE_HOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\])(?::\d+)?$/i;

// Test-only: allow private URLs for integration tests. NEVER set in production.
let _allowPrivateUrls = false;
export function setAllowPrivateUrls(v: boolean) { _allowPrivateUrls = v; }

register(MountTreeTrpc, 'mount', async (mount, ctx) => {
  if (!mount.url) throw new Error('t.mount.trpc: url required');
  try {
    const host = new URL(mount.url).host;
    if (!_allowPrivateUrls && PRIVATE_HOST_RE.test(host)) throw new Error(`t.mount.trpc: private/internal URL denied: ${host}`);
  } catch (e) {
    if (e instanceof TypeError) throw new Error(`t.mount.trpc: invalid URL: ${mount.url}`);
    throw e;
  }
  const { tree } = createTrpcTransport({ url: mount.url, token: mount.token || undefined });
  return createRepathTree(tree, ctx.path, mount.path || '/');
});

register(MountOverlay, 'mount', async (mount, ctx) => {
  if (!mount.layers?.length) throw new Error('t.mount.overlay: layers required');
  const stores: Tree[] = [];
  for (const name of mount.layers) {
    const comp = ctx.node[name];
    if (!isComponent(comp)) throw new Error(`t.mount.overlay: component "${name}" not found`);
    const adapter = resolve(comp.$type, 'mount');
    if (!adapter) throw new Error(`No mount adapter for "${comp.$type}"`);
    const subCtx: MountCtx = { node: ctx.node, path: ctx.path, parentStore: stores[0] ?? ({} as Tree), globalStore: ctx.globalStore };
    stores.push(await adapter(comp, subCtx));
  }
  // First = lower (base), last = upper (writes go here)
  let result = stores[0];
  for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
  return result;
});
