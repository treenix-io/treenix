// Mount adapter registrations — type "mount" context handlers
// Naming: t.mount.{name} — system infrastructure adapters

import { createTrpcTransport } from '#client';
import { getComponent, isComponent, type NodeData, register, resolve } from '#core';
import { createMemoryTree, createOverlayTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createRawFsStore } from '#tree/mimefs';
import { createMongoTree } from '#tree/mongo';
import { createQueryTree } from '#tree/query';
import { createRepathTree } from '#tree/repath';
import { createModsStore } from './mods-mount';
import { createTypesStore } from './types-mount';

export type MountAdapter = (config: NodeData, parentStore: Tree, ctx?: any, globalStore?: Tree) => Tree | Promise<Tree>;

declare module '#core/context' {
  interface ContextHandlers {
    mount: MountAdapter;
  }
}

register('t.mount.mongo', 'mount', async (config: NodeData) => {
  const conn = getComponent<{ uri?: string; db?: string; collection?: string }>(config, 'connection');
  if (!conn) throw new Error("t.mount.mongo requires 'connection' component");
  const uri = conn.uri ?? process.env.MONGO_URI;
  if (!uri) throw new Error('t.mount.mongo: no uri and MONGO_URI not set');
  return createMongoTree(uri, conn.db ?? 'treenity', conn.collection ?? 'nodes');
});

// deps = parent store (used as backing for registry types)
register('t.mount.types', 'mount', (_node, deps) => createTypesStore(deps));

register('t.mount.mods', 'mount', (_node, deps) => createModsStore(deps));

register('t.mount.memory', 'mount', () => createMemoryTree());

register('t.mount.query', 'mount', (config: NodeData, parentStore, ctx, globalStore) => {
  const query = getComponent<{ source: string; match: Record<string, unknown> }>(config, 'query');
  if (!query?.source || !query?.match) throw new Error("t.mount.query requires 'query' component with source and match");
  return createQueryTree({ source: query.source, match: query.match }, globalStore || parentStore);
});

register('t.mount.fs', 'mount', async (config: NodeData) => {
  const root = config['root'] as string | undefined;
  if (!root) throw new Error('t.mount.fs: root required');
  return createFsTree(root);
});

register('t.mount.rawfs', 'mount', async (config: NodeData) => {
  const root = config['root'] as string | undefined;
  if (!root) throw new Error('t.mount.rawfs: root required');
  return createRawFsStore(root);
});

// Federation: mount a remote Treenity instance's tree via tRPC.
// connection.url = remote server, connection.path = remote subtree root (default '/'),
// connection.token = auth token. Path translation handled by createRepathTree.
register('t.mount.tree.trpc', 'mount', async (config: NodeData) => {
  const conn = getComponent<{ url?: string; path?: string; token?: string }>(config, 'connection');
  if (!conn?.url) throw new Error('t.mount.trpc: connection.url required');
  const { tree } = createTrpcTransport({ url: conn.url, token: conn.token });
  return createRepathTree(tree, config.$path, conn.path ?? '/');
});

register('t.mount.overlay', 'mount', async (config: NodeData, parentStore, ctx, globalStore) => {
  const mount = getComponent<{ layers?: string[] }>(config, 't.mount.overlay', 'mount');
  if (!mount?.layers?.length) throw new Error('t.mount.overlay: layers required');
  const stores: Tree[] = [];
  for (const name of mount.layers) {
    const comp = config[name];
    if (!isComponent(comp)) throw new Error(`t.mount.overlay: component "${name}" not found`);
    const adapter = resolve(comp.$type, 'mount');
    if (!adapter) throw new Error(`No mount adapter for "${comp.$type}"`);
    // Overlay sub-adapters receive a component, not full node — they don't need $path
    stores.push(await adapter(comp as NodeData, stores[0] ?? ({} as Tree), ctx, globalStore));
  }
  // First = lower (base), last = upper (writes go here)
  let result = stores[0];
  for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
  return result;
});
