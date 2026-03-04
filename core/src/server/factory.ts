// treenity() — server factory
// Builds the full pipeline from config, returns a composable server instance.

import { type ServiceHandle, startServices } from '#contexts/service/index';
import { A, createNode, R, S, W } from '#core';
import { loadLocalMods } from '#mod';
import { createMemoryTree, type Tree } from '#tree';
import type { Server } from 'node:http';
import { createEnsure, type Ensure, seed as defaultSeed } from './seed';
import { createHttpServer, createPipeline, type Pipeline } from './server';

export type TreenityConfig = {
  dataDir?: string;
  modsDir?: string | false;
  seed?: (store: Tree, ensure: Ensure) => Promise<void>;
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

export async function treenity(config?: TreenityConfig): Promise<TreenityServer> {
  const dataDir = config?.dataDir ?? './data';
  const autostart = config?.autostart ?? true;

  // 1. Load mods
  if (config?.modsDir !== false) {
    const modsDir = config?.modsDir ?? new URL('../mods', import.meta.url).pathname;
    const { loaded, failed } = await loadLocalMods(modsDir, 'server');
    if (failed.length) console.error('failed mods:', failed.map(f => `${f.name}: ${f.error.message}`).join(', '));
    if (loaded.length) console.log(`mods: ${loaded.join(', ')}`);
  }

  // 2. Bootstrap: root node with overlay(base, work)
  const bootstrap = createMemoryTree();
  const rootNode = createNode('/', 'root', {}, {
    mount: { $type: 't.mount.overlay', layers: ['base', 'work'] },
    base: { $type: 't.mount.fs', root: dataDir + '/base' },
    work: { $type: 't.mount.fs', root: dataDir + '/work' },
  });
  rootNode.$acl = [
    { g: 'public', p: R },
    { g: 'authenticated', p: R | S },
    { g: 'admins', p: R | W | A | S },
  ];
  await bootstrap.set(rootNode);

  // 3. Build pipeline
  const pipeline = createPipeline(bootstrap);
  const { store, mountable } = pipeline;

  // 4. Seed
  const seedFn = config?.seed ?? defaultSeed;
  await seedFn(mountable, createEnsure(mountable));

  // 5. Autostart services
  let serviceHandle: ServiceHandle | null = null;
  if (autostart) {
    serviceHandle = await startServices(store, store.subscribe.bind(store) as import('#contexts/service/index').ServiceCtx['subscribe']);
  }

  const stop = async () => {
    await serviceHandle?.stop();
  };

  return {
    store: pipeline.store,
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
