// treenity() — universal server factory
// Single entry point: loads infrastructure, mods, builds pipeline, wires logging.

import '#contexts/schema/index';
import '#contexts/text/index';
import './mount-adapters';

import { type ServiceHandle, startServices } from '#contexts/service/index';
import { type NodeData } from '#core';
import { addOnLog, makeLogPath } from '#log';
import { loadAllMods } from '#mod';
import { createMemoryTree, type Tree } from '#tree';
import type { Server } from 'node:http';
import { deploySeedPrefabs } from './prefab';
import { createEnsure, type Ensure } from './seed';
import { createHttpServer, createPipeline, type Pipeline } from './server';

export type TreenityConfig = {
  rootNode: NodeData;
  dataDir?: string;
  modsDir?: string | false;
  seed?: (tree: Tree, ensure: Ensure) => Promise<void>;
  autostart?: boolean;
};

export type ListenOpts = {
  host?: string;
  allowedOrigins?: string[];
  staticDir?: string;
};

export type TreenityInstance = Pipeline & {
  stop(): Promise<void>;
};

export type TreenityServer = TreenityInstance & {
  listen(port?: number, opts?: ListenOpts): Promise<Server>;
};

export async function treenity(config: TreenityConfig): Promise<TreenityServer> {
  const { rootNode } = config;
  const autostart = config.autostart ?? true;

  // 1. Load mods
  if (config.modsDir !== false) {
    const extraDirs = config.modsDir ? [config.modsDir] : [];
    await loadAllMods('server', ...extraDirs);
  }

  // 2. Bootstrap: root node from config (root.json)
  const bootstrap = createMemoryTree();
  await bootstrap.set(rootNode);

  // 3. Build pipeline
  const pipeline = createPipeline(bootstrap);
  const { tree, mountable } = pipeline;

  // 4. Seed — only on first run (skip if already initialized)
  const initialized = !!(await mountable.get('/sys'));
  if (!initialized) {
    if (config.seed) {
      await config.seed(mountable, createEnsure(mountable));
    } else {
      const seedFilter = (rootNode as Record<string, unknown>).seeds as string[] | undefined;
      await deploySeedPrefabs(mountable, seedFilter);
    }
  }

  // 5. Wire log → tree
  addOnLog(entry => {
    const p = makeLogPath()
    // process.stderr.write(`[log→tree] ${p} ${entry.level}: ${entry.msg.slice(0, 60)}\n`)
    mountable.set({ $path: p, $type: 't.log', ...entry })
      .catch(e => process.stderr.write(`[log write err] ${e.message}\n`))
  })

  // 6. Autostart services
  let serviceHandle: ServiceHandle | null = null;
  if (autostart) {
    serviceHandle = await startServices(tree, tree.subscribe.bind(tree) as import('#contexts/service/index').ServiceCtx['subscribe']);
  }

  const stop = async () => {
    await serviceHandle?.stop();
  };

  return {
    tree: pipeline.tree,
    mountable: pipeline.mountable,
    watcher: pipeline.watcher,
    router: pipeline.router,
    createContext: pipeline.createContext,
    stop,

    async listen(port = 3211, opts?: ListenOpts) {
      const host = opts?.host ?? '127.0.0.1';
      const server = createHttpServer(pipeline, {
        allowedOrigins: opts?.allowedOrigins,
        staticDir: opts?.staticDir,
      });
      return new Promise<Server>((resolve) => {
        server.listen(port, host, () => {
          console.log(`treenity ${host}:${port}`);
          resolve(server);
        });
      });
    },
  };
}
