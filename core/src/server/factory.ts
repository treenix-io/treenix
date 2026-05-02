// treenix() — universal server factory
// Single entry point: loads infrastructure, mods, builds pipeline, wires logging.

import '#contexts/text/index';
import '#schema/action';
import './mount-adapters';

import { type ServiceHandle, startServices } from '#contexts/service/index';
import { type NodeData } from '#core';
import { addOnLog, makeLogPath } from '#log';
import { loadAllMods } from '#mod';
import { loadSchemasFromDir } from '#schema/load';
import { createMemoryTree, type Tree } from '#tree';
import type { Server } from 'node:http';
import { deploySeedPrefabs } from './prefab';
import { createEnsure, type Ensure } from './seed/index';
import { createHttpServer, createPipeline, type Pipeline } from './server';

export type TreenixConfig = {
  rootNode: NodeData;
  modsDir?: string | false;
  seed?: (tree: Tree, ensure: Ensure) => Promise<void>;
  autostart?: boolean;
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

  // 1. Load mods
  if (config.modsDir !== false) {
    const extraDirs = config.modsDir ? [config.modsDir] : [];
    await loadAllMods('server', ...extraDirs);
  }

  // Dev-only: register test.schema-widget (exercises every form field widget)
  if (process.env.NODE_ENV !== 'production') {
    await import('#schema/schema-test-widget');
    loadSchemasFromDir(new URL('../schema/schemas', import.meta.url).pathname);
  }

  // 2. Bootstrap: root node from config (root.json)
  const bootstrap = createMemoryTree();
  await bootstrap.set(rootNode);

  // 3. Build pipeline
  const pipeline = createPipeline(bootstrap);
  const { tree, cdc, mountable } = pipeline;

  // 4. Seed — always run, deployNodes is idempotent per-node (skips existing)
  if (config.seed) {
    await config.seed(mountable, createEnsure(mountable));
  } else {
    const seedFilter = (rootNode as Record<string, unknown>).seeds as string[] | undefined;
    console.log(`[seed] deploying prefabs, filter: ${JSON.stringify(seedFilter)}`);
    await deploySeedPrefabs(mountable, seedFilter);
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
    serviceHandle = await startServices(tree, cdc.subscribe.bind(cdc) as import('#contexts/service/index').ServiceCtx['subscribe']);
  }

  const stop = async () => {
    await serviceHandle?.stop();
  };

  return {
    tree: pipeline.tree,
    cdc: pipeline.cdc,
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
