import type { NodeData } from '#core';
import { setCtxProvider } from '#log';
import type { Tree } from '#tree';

export type ExecCtx = {
  node: NodeData;
  tree: Tree;
  signal: AbortSignal;
  [key: string]: unknown;
};

type ActionContextRuntime = {
  get(): ExecCtx | undefined;
  run<T>(ctx: ExecCtx, action: () => T): T;
};

const directRuntime: ActionContextRuntime = {
  get: () => undefined,
  run: (_ctx, action) => action(),
};

let runtime = directRuntime;

/** Server composition installs AsyncLocalStorage. Browser prediction keeps the
 * direct runtime and therefore has no ambient async context. */
export function installActionContextRuntime(next: ActionContextRuntime): void {
  runtime = next;
}

export function currentExecCtx(): ExecCtx | undefined {
  return runtime.get();
}

export function runWithExecCtx<T>(ctx: ExecCtx, action: () => T): T {
  return runtime.run(ctx, action);
}

setCtxProvider(() => currentExecCtx() ?? null);
