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

// deps = parent tree (used as backing for registry types)
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
  const tree = await createFsTree(root);
  // shared: true — full tree paths (multiple mount points into one dir)
  // default: dedicated — repath to local /
  return config['shared'] ? tree : createRepathTree(tree, config.$path, '/');
});

register('t.mount.rawfs', 'mount', async (config: NodeData) => {
  const root = config['root'] as string | undefined;
  if (!root) throw new Error('t.mount.rawfs: root required');
  const tree = await createRawFsStore(root);
  return config['shared'] ? tree : createRepathTree(tree, config.$path, '/');
});

// Federation: mount a remote Treenity instance's tree via tRPC.
// connection.url = remote server, connection.path = remote subtree root (default '/'),
// connection.token = auth token. Path translation handled by createRepathTree.
// F18: reject private/internal IP ranges to prevent SSRF via mount creation.
const PRIVATE_HOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\])(?::\d+)?$/i;

// Test-only: allow private URLs for integration tests. NEVER set in production.
let _allowPrivateUrls = false;
export function setAllowPrivateUrls(v: boolean) { _allowPrivateUrls = v; }

register('t.mount.tree.trpc', 'mount', async (config: NodeData) => {
  const conn = getComponent<{ url?: string; path?: string; token?: string }>(config, 'connection');
  if (!conn?.url) throw new Error('t.mount.trpc: connection.url required');
  try {
    const host = new URL(conn.url).host;
    if (!_allowPrivateUrls && PRIVATE_HOST_RE.test(host)) throw new Error(`t.mount.trpc: private/internal URL denied: ${host}`);
  } catch (e) {
    if (e instanceof TypeError) throw new Error(`t.mount.trpc: invalid URL: ${conn.url}`);
    throw e;
  }
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
    // Propagate parent $path so sub-adapters can repath correctly
    const subConfig = { ...comp, $path: config.$path } as NodeData;
    stores.push(await adapter(subConfig, stores[0] ?? ({} as Tree), ctx, globalStore));
  }
  // First = lower (base), last = upper (writes go here)
  let result = stores[0];
  for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
  return result;
});
