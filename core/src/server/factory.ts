// treenix() — universal server factory
// Single entry point: loads infrastructure, mods, builds pipeline, wires logging.

import '#contexts/text/index';
import '#schema/action';
import '#mount/adapters';

import { type ServiceHandle, startServices } from '#contexts/service/index';
import { A, type GroupPerm, type NodeData, R, S, W } from '#core';
import { addOnLog, createLogger, makeLogPath } from '#log';
import { loadAllMods } from '#mod';
import { getAnonKey } from '#security/anon';
import { createMemoryTree, type Tree } from '#tree';
import { sweepTrash } from '#tree/policy';
import type { Server } from 'node:http';
import { type DelegationHooks, withActor } from './actions';
import { applyDevDefaults } from './dev-defaults';
import { deploySeedPrefabs } from './prefab';
import { createHttpServer, createPipeline, type Pipeline } from './server';
import type { SessionExecutor } from './trpc';

// Log lines carry tokens, error payloads and user ids. Same shape as the
// /sys/trash seed: admins only, the system identity inherits its root grant.
const LOGS_ACL: GroupPerm[] = [
  { g: 'admins', p: R | W | A | S },
  { g: 'authenticated', p: 0 },
  { g: 'public', p: 0 },
];

/** Converge /sys/logs to admin-only before the log writer persists entries
 *  there — it otherwise inherits /sys public R, and seeds skip an existing
 *  node, so an ACL-less container stayed world-readable. */
async function ensureLogsContainer(tree: Tree): Promise<void> {
  const node = await tree.get('/sys/logs');
  if (!node) await tree.set({ $path: '/sys/logs', $type: 't.logs', $acl: LOGS_ACL });
  else if (JSON.stringify(node.$acl) !== JSON.stringify(LOGS_ACL)) await tree.patch('/sys/logs', [['r', '$acl', LOGS_ACL]]);
}

export type TreenixConfig = {
  rootNode: NodeData;
  modsDir?: string | false;
  seed?: (tree: Tree) => Promise<void>;
  autostart?: boolean;
  /** Optional outer wrapper applied to the assembled pipeline tree.
   *  Mods compose extra concerns (e.g. audit) without modifying core pipeline. */
  wrapTree?: (tree: Tree) => Tree;
  /** Delegation audit hooks factory (core-pa3m) — called by createPipeline with
   *  the pre-wrap (subscribed) tree; returns onDelegating/onDelegatedSettled.
   *  Wired by main.ts alongside wrapTree when the audit mod is on. Absent =
   *  delegated executes leave no local audit record. */
  execHooks?: (tree: Tree) => DelegationHooks;
  /** Optional health probe — when present, server gates all non-/health requests.
   *  /health endpoint always responds with the current state (200 healthy, 503 not).
   *  Leave undefined to disable health gating entirely. */
  healthCheck?: () => { healthy: boolean; reason: string } | Promise<{ healthy: boolean; reason: string }>;
  /** Optional dispatcher for workload-bound sessions. Without it, sessions with
   *  `scopeRef` cannot be served — server fails the request with INTERNAL_SERVER_ERROR.
   *  Composition root (e.g. main.ts) wires this from the harness mod. */
  executor?: SessionExecutor;
  /** Opt out of fail-fast mod loading (core-ns6p.1). Default false: any failed mod
   *  aborts boot (AggregateError). Set true only when modsDir is USER-writable
   *  (e.g. desktop plugin dirs) — a broken user plugin must not brick boot; each
   *  failure is logged loudly and boot continues with the mods that loaded. */
  allowPartialMods?: boolean;
};

export type ListenOpts = {
  host?: string;
  allowedOrigins?: string[];
  staticDir?: string;
};

export type TreenixInstance = Pipeline & {
  stop(): Promise<void>;
};

export type TreenixServer = TreenixInstance & {
  listen(port?: number, opts?: ListenOpts): Promise<Server>;
};

export async function treenix(config: TreenixConfig): Promise<TreenixServer> {
  const { rootNode } = config;
  const autostart = config.autostart ?? true;

  // Dev-mode flags (VITE_DEV_LOGIN, MCP_DEV_ADMIN). No-op in production.
  // Lives here so external consumers (starter, vite plugins) get them via the
  // factory without duplicating bootstrap code in every entry point.
  applyDevDefaults();

  // 1. Load mods. A failed mod leaves partially published registrations (types
  // registered before the throw stay visible) — booting on that state serves a
  // half-alive mod, so fail the boot loudly instead (joint decision core-ns6p.1;
  // atomic registry generations parked until real hot reload/unload exists).
  if (config.modsDir !== false) {
    const extraDirs = config.modsDir ? [config.modsDir] : [];
    const mods = await loadAllMods('server', ...extraDirs);
    if (mods.failed.length) {
      if (config.allowPartialMods) {
        const log = createLogger('boot');
        for (const f of mods.failed) log.error(`mod load failed: ${f.name}`, f.error);
      } else {
        throw new AggregateError(
          mods.failed.map((f) => f.error),
          `mod load failed: ${mods.failed.map((f) => f.name).join(', ')}`,
        );
      }
    }
  }

  // 1a. Optional storage backends self-register their mount types (mongo.collection
  // lives in @treenx/mongo/mount — core stays mongo-agnostic). Missing package =
  // backend not installed, fine; any other load error must fail the boot loudly.
  try {
    await import('@treenx/mongo/mount');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }

  // 2. Bootstrap: root node from config (root.json)
  const bootstrap = createMemoryTree();
  await bootstrap.set(rootNode);

  // 3. Build pipeline. wrapTree (audit) is applied INSIDE createPipeline — above
  // subscriptions but before the tRPC router — so per-user tRPC writes are audited
  // (core-dpp). Boot writes (seed/log/autostart) go through pipeline.systemTree
  // (= withAcl(mountable, ...), below the wrap), so audit never cycles on startup.
  const pipeline = createPipeline(bootstrap, { executor: config.executor }, config.wrapTree, config.execHooks);
  const { tree, cdc, systemTree } = pipeline;

  // 4. Seed — always run, deployNodes is idempotent per-node (skips existing)
  if (config.seed) {
    await config.seed(systemTree);
  } else {
    const seedFilter = (rootNode as Record<string, unknown>).seeds as string[] | undefined;
    console.log(`[seed] deploying prefabs, filter: ${JSON.stringify(seedFilter)}`);
    await deploySeedPrefabs(systemTree, seedFilter);
  }

  // 4b. Boot-time anon-key validation. Fails fast in prod if TREENIX_ANON_KEY
  // missing/malformed; dev path lazy-creates persistent key in tree.
  // Caching here avoids first-request stall and makes prod misconfiguration loud.
  await getAnonKey(systemTree);

  // 4c. Trash GC — systemTree sits below withTrash, so the purge is a hard delete.
  await sweepTrash(systemTree);

  // 5. Wire log → tree: every entry becomes a /sys/logs/<ts> node — the full,
  // ever-growing log history (owner decision 2026-07-03), browsable via tree/MCP.
  // The ring buffer keeps filling in parallel (log.ts push) for t.logs.query.
  await ensureLogsContainer(systemTree);
  addOnLog(entry => {
    systemTree.set({ $path: makeLogPath(), $type: 't.log', ...entry })
      .catch(e => process.stderr.write(`[log write err] ${e.message}\n`))
  })

  // 6. Autostart services. Actor-bound tree (core-anz4.14): supervisor
  // bookkeeping writes (ref children) attribute as system:autostart; the
  // autostart handler re-binds per started service (service:<path>).
  let serviceHandle: ServiceHandle | null = null;
  if (autostart) {
    const serviceTree = withActor(tree, { id: 'system:autostart' });
    serviceHandle = await startServices(serviceTree, cdc.subscribe.bind(cdc));
  }

  const stop = async () => {
    await serviceHandle?.stop();
  };

  return {
    tree: pipeline.tree,
    cdc: pipeline.cdc,
    mountable: pipeline.mountable,
    systemTree: pipeline.systemTree,
    watcher: pipeline.watcher,
    router: pipeline.router,
    createContext: pipeline.createContext,
    stop,

    async listen(port = 3211, opts?: ListenOpts) {
      const host = opts?.host ?? '127.0.0.1';
      const server = createHttpServer(pipeline, {
        allowedOrigins: opts?.allowedOrigins,
        staticDir: opts?.staticDir,
        healthCheck: config.healthCheck,
      });
      return new Promise<Server>((resolve) => {
        server.listen(port, host, () => {
          const root = rootNode as Record<string, unknown>;
          const mount = root.mount as Record<string, unknown> | undefined;
          const storage = mount?.$type ?? 'memory';
          const layers = mount?.layers as string[] | undefined;
          if (layers) {
            const layerInfo = layers.map(k => {
              const comp = root[k] as Record<string, unknown> | undefined;
              return `  ${k}: ${comp?.$type ?? '?'}  ${comp?.root ?? comp?.uri ?? ''}`;
            }).join('\n');
            console.log(`treenix ${host}:${port}  ${storage}\n${layerInfo}`);
          } else {
            const detail = mount?.root ?? mount?.uri ?? '';
            console.log(`treenix ${host}:${port}  ${storage}${detail ? `  ${detail}` : ''}`);
          }
          resolve(server);
        });
      });
    },
  };
}
