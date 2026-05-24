// Mount adapter registrations — type "mount" context handlers
// Naming: t.mount.{name} — system infrastructure adapters
// Each adapter receives its mount component + MountCtx (not the whole node).

import { createTrpcTransport } from '#client';
import { registerType } from '#comp';
import { isComponent, register } from '#core';
import { createMemoryTree, createOverlayTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createRawFsTree } from '#tree/mimefs';
import { createQueryTree, type QueryConfig } from '#tree/query';
import { createRepathTree } from '#tree/repath';
import { createModsTree } from './mods';
import { type MountCtx, resolveAdapter } from './index';
import { createTypesTree } from './types';

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
  /** Enable `tree.watch` via Mongo change streams. OFF by default — change
   *  streams require a replica set (single-node `mongod` lacks them), and
   *  enabling pre-images via `collMod` needs admin permission. Turn on only
   *  when you need to observe out-of-band writes (manual mongo writes, other
   *  apps sharing the DB, migrations). When OFF, `tree.watch` is undefined
   *  on the wrapped adapter, and any caller invoking it gets a clean
   *  TypeError ("watch is not a function") instead of a silent stall. */
  watch = false;
  /** Dedup TTL (ms) for self-write suppression in the external-watch loop.
   *  When the mongo change stream surfaces a write we just performed through
   *  the pipeline (withSubscriptions emitted it already), the dedup buffer
   *  recognizes the (path, $rev) pair and skips re-emission to clients.
   *  5_000 ms covers typical replica-set lag (< 1s) with generous headroom.
   *  Set 0 to disable dedup (useful only when the mount is purely external
   *  and no in-pipeline writes flow through it). Effective TTL is
   *  [dedupWindowMs, 2 * dedupWindowMs] due to two-bucket rotation. */
  dedupWindowMs = 5_000;
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
  const tree = await createMongoTree(uri, mount.db, mount.collection, { watch: mount.watch });
  const wrapped = mount.shared ? tree : createRepathTree(tree, ctx.path, '/');

  // Wire external-watch into the subscription bus when:
  //   - mount declares watch (change stream enabled on the adapter)
  //   - the adapter actually exposed tree.watch (mount.watch was honored)
  //   - the host pipeline supplied startExternalWatch (createPipeline does)
  // pathPrefix repaths change-stream events into the outer namespace:
  //   shared mount → tree uses global paths → pathPrefix '/' (no-op)
  //   non-shared    → tree's paths are mount-local → pathPrefix = ctx.path
  if (mount.watch && tree.watch && ctx.startExternalWatch) {
    const pathPrefix = mount.shared ? '/' : ctx.path;
    ctx.startExternalWatch(tree, {
      pathPrefix,
      dedupWindowMs: mount.dedupWindowMs,
      source: `mongo@${ctx.path}`,
    });
  }

  return wrapped;
});

register(MountTypes, 'mount', (_mount, ctx) => createTypesTree(ctx.parentStore));

register(MountMods, 'mount', () => createModsTree());

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
  const tree = await createRawFsTree(mount.root, mount.shared ? '' : ctx.path);
  return mount.shared ? tree : createRepathTree(tree, ctx.path, '/');
});

// Federation: mount a remote Treenix instance's tree via tRPC.
// F18: reject private/internal IP ranges to prevent SSRF via mount creation.
const PRIVATE_HOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\])(?::\d+)?$/i;

// Test-only: allow private URLs for integration tests. NEVER set in production.
let _allowPrivateUrls = false;
export function setAllowPrivateUrls(v: boolean) { _allowPrivateUrls = v; }

// R4-MOUNT-2: scrub userinfo (and querystring) from URLs before they appear in error messages or logs.
// Operators commonly paste credentials as `https://user:TOKEN@host/`; without scrubbing, the token
// reaches downstream callers via tRPC error propagation.
export function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

register(MountTreeTrpc, 'mount', async (mount, ctx) => {
  if (!mount.url) throw new Error('t.mount.trpc: url required');
  try {
    const host = new URL(mount.url).host;
    if (!_allowPrivateUrls && PRIVATE_HOST_RE.test(host)) throw new Error(`t.mount.trpc: private/internal URL denied: ${host}`);
  } catch (e) {
    if (e instanceof TypeError) throw new Error(`t.mount.trpc: invalid URL: ${safeUrlForLog(mount.url)}`);
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
    // First layer sees the Overlay's own parent; subsequent layers see the
    // previously-built layer as their parent. Previously this used `{} as Tree`
    // for layer 0 — a lie that crashes any adapter touching parentStore.
    const subCtx: MountCtx = { node: ctx.node, path: ctx.path, parentStore: stores[0] ?? ctx.parentStore, globalStore: ctx.globalStore };
    stores.push(await resolveAdapter(comp, subCtx));
  }
  // First = lower (base), last = upper (writes go here)
  let result = stores[0];
  for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
  return result;
});
