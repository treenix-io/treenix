// Mount adapter registrations — type "mount" context handlers
// Naming: t.mount.{name} — system infrastructure adapters
// Each adapter receives its mount component + MountCtx (not the whole node).

import { createTrpcTransport } from '#client';
import { registerType } from '#comp';
import { getComponentByName, register } from '#core';
import { OpError } from '#errors';
import { createMemoryTree, createOverlayTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createRawFsTree } from '#tree/mimefs';
import { createQueryTree, type QueryConfig, queryConfigOf } from '#tree/query';
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
  /** Enable `tree.watch` via Mongo change streams. OFF by default — change
   *  streams require a replica set (single-node `mongod` lacks them), and
   *  enabling pre-images via `collMod` needs admin permission. Turn on only
   *  when you need to observe out-of-band writes (manual mongo writes, other
   *  apps sharing the DB, migrations). When OFF, `tree.watch` is undefined
   *  on the wrapped adapter, and any caller invoking it gets a clean
   *  TypeError ("watch is not a function") instead of a silent stall. */
  watch = false;
  /** Dedup TTL (ms) for self-write suppression in the external-watch loop.
   *  Default 0 = OFF (every external event forwarded, including echoes of
   *  in-pipeline writes — idempotent, just doubles event volume per write).
   *
   *  Turn on (e.g. 5_000) ONLY when you accept the documented race window:
   *  the dedup heuristic uses (path, $rev) keys, which cannot distinguish
   *  a delayed change-stream echo of an OLD remove from a CURRENT external
   *  remove. Under a self-remove → self-recreate sequence within the
   *  window, a delayed remove echo can leave client state inconsistent with
   *  the storage. Operation-identity dedup (preimage `$rev` / writer token)
   *  would close this; not implemented yet.
   *
   *  Effective TTL when enabled is [dedupWindowMs, 2 * dedupWindowMs] due
   *  to two-bucket rotation. */
  dedupWindowMs = 0;
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

export class MountTreeTrpc {
  url = '';
  path = '/';
  token = '';
  /** Allow a loopback/private/link-local host (local peers, tests). Off by
   *  default: guards admin typos against internal endpoints (F3). */
  allowPrivate = false;
}
registerType('t.mount.tree.trpc', MountTreeTrpc);

// ── Adapters ──

function required(type: string, field: string, at: string): never {
  throw new OpError('BAD_REQUEST', `${type} at ${at}: ${field} required`);
}

register(MountMongo, 'mount', async (mount, ctx) => {
  const uri = mount.uri || process.env.MONGO_URI;
  if (!uri) required('t.mount.mongo', 'uri (or MONGO_URI env)', ctx.path);
  const { createMongoTree } = await import('@treenx/mongo');
  const tree = await createMongoTree(uri, mount.db, mount.collection, { watch: mount.watch, nsMigrate: mount.nsMigrate });
  const wrapped = mount.shared ? tree : createRepathTree(tree, ctx.path, '/');

  if (mount.watch && tree.watch && ctx.startExternalWatch) {
    // shared = tree uses outer (global) paths; non-shared = mount-local.
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

// F3: WHATWG URL normalizes every IPv4 spelling (0x7f000001, 2130706433, 127.1
// → 127.0.0.1) and IPv6 literals, so the check runs on `hostname`, never on the
// raw string. DNS names resolving to private addresses stay out of scope —
// authoring is admin-only (F4); this only catches typos.
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::' || v6 === '::1' || v6.startsWith('::ffff:') || /^(f[cd]|fe[89ab])/.test(v6);
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Federation: mount a remote Treenix instance's tree via tRPC.
register(MountTreeTrpc, 'mount', async (mount, ctx) => {
  if (!mount.url) required('t.mount.tree.trpc', 'url', ctx.path);
  // The URL may carry credentials — never echo it into errors.
  if (!URL.canParse(mount.url)) throw new OpError('BAD_REQUEST', `t.mount.tree.trpc at ${ctx.path}: invalid url`);
  const { hostname } = new URL(mount.url);
  if (!mount.allowPrivate && isPrivateHost(hostname)) {
    throw new OpError('BAD_REQUEST', `t.mount.tree.trpc at ${ctx.path}: private host ${hostname} needs allowPrivate`);
  }
  const { tree } = createTrpcTransport({ url: mount.url, token: mount.token || undefined });
  return createRepathTree(tree, ctx.path, mount.path || '/');
});

register(MountOverlay, 'mount', async (mount, ctx) => {
  if (!mount.layers?.length) required('t.mount.overlay', 'layers', ctx.path);
  const stores: Tree[] = [];
  for (const name of mount.layers) {
    const comp = getComponentByName(ctx.node, name);
    if (!comp) throw new OpError('BAD_REQUEST', `t.mount.overlay at ${ctx.path}: layer component "${name}" not found`);
    // Later layers see the base layer as their parent store.
    stores.push(await resolveAdapter(comp, { ...ctx, parentStore: stores[0] ?? ctx.parentStore }));
  }
  // layers[0] is the base; later layers stack on top (last layer = writes).
  let result = stores[0];
  for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
  return result;
});
