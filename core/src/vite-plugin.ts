// Vite plugin: run the @treenx/core server in a SEPARATE Node process from Vite.
//
// Why a subprocess: inside Vite's process Vite 8 installs sync Module.registerHooks
// for .ts files; any later `register()` / `tsImport()` from tsx is shadowed, and
// project-local server.ts mods load as empty stubs — registerType() never runs and
// actions vanish from the registry. A child process avoids the conflict entirely:
// tsx loads the engine + mods with no Vite interference, and Vite proxies
// /trpc + /api to the child on port 3211.
//
// Usage:
//   import treenixServer from '@treenx/core/vite-plugin';
//   plugins: [treenixServer(), ...]
//
// Framework-agnostic: the frontend Vite plugin lives in its renderer-specific
// package (e.g. @treenx/react/vite-plugin).

import type { Plugin } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export type TreenixServerOpts = {
  /** Path to root.json (default: 'root.json' in CWD). */
  configPath?: string;
  /** Extra args appended after configPath (forwarded to main.ts). */
  args?: string[];
};

export default function treenixServer(opts: TreenixServerOpts = {}): Plugin {
  const configPath = opts.configPath ?? 'root.json';
  let child: ChildProcess | null = null;

  return {
    name: 'treenix-server',
    configureServer() {
      // Resolve main.ts relative to this plugin file so it works from both
      // dist (node_modules/@treenx/core/dist/) and src (workspace dev mode).
      const here = dirname(fileURLToPath(import.meta.url));
      const mainTs = resolve(join(here, '..', 'src', 'server', 'main.ts'));
      child = spawn(
        process.execPath,
        ['--import', 'tsx', '--conditions=development', mainTs, configPath, ...(opts.args ?? [])],
        { stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development' } },
      );
      child.on('exit', code => {
        if (code !== 0 && code !== null) console.error(`[treenix-server] exited with code ${code}`);
      });
      const kill = () => child?.kill('SIGTERM');
      process.once('exit', kill);
      process.once('SIGINT', kill);
      process.once('SIGTERM', kill);
    },
  };
}
