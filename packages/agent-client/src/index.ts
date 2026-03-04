// @treenity/agent-client — TOFU agent connection SDK
// Connect an external agent to a Treenity server with Trust On First Use handshake.
// All paths are relative to agent's subtree — agent writes "config", gets /agents/bot/config.

import { createTrpcTransport, type TreenityClient } from '@treenity/core/client';

export type AgentOpts = {
  url: string;   // Treenity server URL, e.g. 'http://localhost:3211'
  path: string;  // agent port path, e.g. '/agents/my-bot'
  key: string;   // secret key for TOFU authentication
};

export type ConnectResult =
  | { status: 'pending' }
  | { status: 'approved'; client: TreenityClient; token: string; userId: string };

export type WaitOpts = {
  interval?: number;  // poll interval in ms (default: 5000)
  timeout?: number;   // total timeout in ms (default: 300000 = 5 min)
};

/** Resolve relative path to absolute. "config" → "/agents/bot/config", "" → "/agents/bot" */
function scopePath(base: string, rel: string): string {
  if (rel.startsWith('/')) return rel; // escape hatch: absolute path
  const clean = rel.replace(/^\.\//, '').replace(/^\.?$/, '');
  return clean ? `${base}/${clean}` : base;
}

/** Wrap TreenityClient so all paths are relative to agent's subtree */
function scopeClient(raw: TreenityClient, base: string): TreenityClient {
  return {
    tree: {
      get: (path, ctx) => raw.tree.get(scopePath(base, path), ctx),
      getChildren: (path, opts, ctx) => raw.tree.getChildren(scopePath(base, path), opts, ctx),
      set: (node, ctx) => raw.tree.set({ ...node, $path: scopePath(base, node.$path) }, ctx),
      remove: (path, ctx) => raw.tree.remove(scopePath(base, path), ctx),
      patch: (path, ops, ctx) => raw.tree.patch(scopePath(base, path), ops, ctx),
    },
    execute: (path, action, data, o) => raw.execute(scopePath(base, path), action, data, o),
    watch: raw.watch,
    watchPath: (path, onEvent) => raw.watchPath(scopePath(base, path), onEvent),
  };
}

export function createAgentClient(opts: AgentOpts) {
  const { url, path, key } = opts;

  /** Single connect attempt. Returns status — caller decides what to do. */
  async function connect(): Promise<ConnectResult> {
    const anon = createTrpcTransport({ url });
    const res = await anon.trpc.agentConnect.mutate({ path, key });

    if (res.status === 'pending') {
      return { status: 'pending' };
    }

    if (res.status === 'approved') {
      const raw = createTrpcTransport({ url, token: res.token });
      const client = scopeClient(raw, path);
      return { status: 'approved', client, token: res.token, userId: res.userId };
    }

    throw new Error(`Unexpected agent status: ${(res as any).status}`);
  }

  /** Poll until admin approves. Throws on timeout. */
  async function waitForApproval(waitOpts?: WaitOpts): Promise<TreenityClient> {
    const interval = waitOpts?.interval ?? 5000;
    const timeout = waitOpts?.timeout ?? 5 * 60 * 1000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const result = await connect();

      if (result.status === 'approved') {
        console.log(`[agent] connected as ${result.userId}`);
        return result.client;
      }

      console.log(`[agent] pending approval, retrying in ${interval / 1000}s...`);
      await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(`[agent] timeout waiting for approval (${timeout / 1000}s)`);
  }

  return { connect, waitForApproval };
}

export type { TreenityClient } from '@treenity/core/client';
export { createNodeClient } from '@treenity/core/client';
