import type { NodeData } from '#core';
import { setCtxProvider } from '#log';
import type { Tree } from '#tree';

export type ExecCtx = {
  node: NodeData;
  tree: Tree;
  signal: AbortSignal;
  [key: string]: unknown;
};

/** Thrown when action code asks for ctx (or a ctx field) that this runtime
 *  cannot provide. The optimistic replay lane treats it as "skip prediction,
 *  server round-trip is authoritative" (core-anz4.18). */
export class CtxUnavailableError extends Error {
  code = 'CTX_UNAVAILABLE' as const;
}

type ActionContextRuntime = {
  get(): ExecCtx | undefined;
  run<T>(ctx: ExecCtx, action: () => T): T;
};

/** Direct runtime (browser, no server composition): ctx is visible for the
 *  synchronous span of the action only — enough for optimistic prediction
 *  (core-anz4.18). Sync windows are atomic in JS, so nesting restores via
 *  finally and continuations after await deterministically see undefined —
 *  no cross-action leak. The server installs AsyncLocalStorage instead. */
let syncCtx: ExecCtx | undefined;

const directRuntime: ActionContextRuntime = {
  get: () => syncCtx,
  run(ctx, action) {
    const prev = syncCtx;
    syncCtx = ctx;
    try {
      return action();
    } finally {
      syncCtx = prev;
    }
  },
};

let runtime = directRuntime;

export function installActionContextRuntime(next: ActionContextRuntime): void {
  runtime = next;
}

export function currentExecCtx(): ExecCtx | undefined {
  return runtime.get();
}

export function runWithExecCtx<T>(ctx: ExecCtx, action: () => T): T {
  return runtime.run(ctx, action);
}

const neverAborted = new AbortController().signal;

/** Ctx for browser-side optimistic prediction: the draft node/comp is the
 *  entire safe subset. Server-only facilities (tree, nc) throw at ACCESS —
 *  the standard `const { node, tree } = getCtx()` destructure dies before
 *  the action body mutates the draft, so the prediction skips cleanly
 *  instead of half-executing (core-anz4.18). deps stays undefined: actions
 *  with `needs` are skipped upstream, dep resolution is server-side. */
export function predictionCtx(node: NodeData, comp?: object): ExecCtx {
  return {
    node,
    comp,
    signal: neverAborted,
    get tree(): Tree { throw new CtxUnavailableError('ctx.tree is server-only'); },
    get nc(): never { throw new CtxUnavailableError('ctx.nc is server-only'); },
  };
}

setCtxProvider(() => currentExecCtx() ?? null);
