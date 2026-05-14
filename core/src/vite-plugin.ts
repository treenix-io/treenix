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
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export type TreenixServerOpts = {
  /** Path to root.json (default: 'root.json' in CWD). */
  configPath?: string;
  /** Extra args appended after configPath (forwarded to main.ts). */
  args?: string[];
  /** Port the backend listens on (default: 3211). Must match Vite proxy target. */
  port?: number;
  /** Max wait for backend port to open, in ms (default: 30000). */
  readyTimeoutMs?: number;
};

// Poll TCP connect to port until it accepts a connection or timeout elapses.
// Used to gate Vite's first request until the spawned backend is actually listening,
// otherwise the browser races vite proxy → ECONNREFUSED on /trpc/events.
async function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const sock: Socket = connect(port, host);
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`treenixServer: backend did not open ${host}:${port} within ${timeoutMs}ms`);
}

export default function treenixServer(opts: TreenixServerOpts = {}): Plugin {
  const configPath = opts.configPath ?? 'root.json';
  const port = opts.port ?? 3211;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  let child: ChildProcess | null = null;

  return {
    name: 'treenix-server',
    async configureServer() {
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

      // Block Vite startup until the backend port is open. Without this, the
      // browser's first /trpc/events SSE call (and the initial getChildren
      // batches) hit Vite before the proxy target accepts connections, surfacing
      // as `ECONNREFUSED 127.0.0.1:3211` in the console.
      await waitForPort(port, '127.0.0.1', readyTimeoutMs);
    },
  };
}
