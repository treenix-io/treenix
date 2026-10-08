// External Watch — pump an outside Tree.watch stream into the subscription
// bus. Repath, optional self-write dedup, retry/backoff, abort lifecycle.

import type { Tree, TreeEvent } from '#tree';
import type { OnSelfWrite } from './index';

export type RunExternalWatchOpts = {
  pathPrefix: string;
  forwardEvent: (event: TreeEvent) => void;
  invalidateCachePath?: (outerPath: string) => void;
  invalidateCacheAll?: () => void;
  onSelfWrite?: OnSelfWrite;
  /** Self-write dedup TTL (ms). 0 = off. Effective window is
   *  [dedupWindowMs, 2*dedupWindowMs) due to two-bucket rotation. */
  dedupWindowMs?: number;
  signal: AbortSignal;
  /** Initial retry delay (ms) for exponential backoff after a stream error.
   *  Doubles on each consecutive failure, capped at `maxRetryMs`. Default 1000. */
  initialRetryMs?: number;
  /** Max retry delay cap. Default 30_000. */
  maxRetryMs?: number;
  /** Identifier for log lines — e.g. mount path or adapter type. */
  source: string;
};

const DEFAULT_INITIAL_RETRY_MS = 1000;
const DEFAULT_MAX_RETRY_MS = 30_000;

function repath(prefix: string, path: string): string {
  if (prefix === '' || prefix === '/') return path;
  if (path === '/') return prefix;
  return prefix + path;
}

function eventRev(event: TreeEvent): number | undefined {
  if (event.type === 'patch') return event.rev;
  if (event.type === 'set') return (event.node as { $rev?: number }).$rev;
  return undefined;
}

function dedupKey(type: TreeEvent['type'], path: string, rev: number | undefined): string | null {
  // Removes are NEVER deduped: no $rev to key on, and path-only would falsely
  // suppress a real external delete that follows a self-remove + recreate.
  if (type === 'remove') return null;
  return `S:${path}@${rev ?? '?'}`;
}

export function runExternalWatch(tree: Tree, opts: RunExternalWatchOpts): void {
  if (!tree.watch) {
    throw new Error(`runExternalWatch[${opts.source}]: tree does not expose watch`);
  }
  const dedupWindowMs = opts.dedupWindowMs ?? 0;
  const dedupEnabled = dedupWindowMs > 0;
  if (dedupEnabled && !opts.onSelfWrite) {
    throw new Error(`runExternalWatch[${opts.source}]: dedupWindowMs > 0 requires onSelfWrite`);
  }

  const initialRetryMs = opts.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
  const maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const { pathPrefix, forwardEvent, invalidateCachePath, invalidateCacheAll, onSelfWrite, signal, source } = opts;

  // ── Dedup buffer (two-bucket rotation) ──
  let bucketCurrent = new Set<string>();
  let bucketPrevious = new Set<string>();
  let rotateTimer: ReturnType<typeof setInterval> | null = null;
  let selfWriteUnsub: (() => void) | null = null;
  let lastRotation = 0;

  function rotateBuckets() {
    // Interval callbacks can coalesce while the event loop is stalled.
    const periods = Math.floor((performance.now() - lastRotation) / dedupWindowMs);
    if (periods < 1) return;
    bucketPrevious = periods === 1 ? bucketCurrent : new Set();
    bucketCurrent = new Set();
    lastRotation += periods * dedupWindowMs;
  }

  function isRecent(key: string): boolean {
    rotateBuckets();
    return bucketCurrent.has(key) || bucketPrevious.has(key);
  }

  if (dedupEnabled) {
    lastRotation = performance.now();
    rotateTimer = setInterval(rotateBuckets, dedupWindowMs);
    if (typeof rotateTimer.unref === 'function') rotateTimer.unref();

    selfWriteUnsub = onSelfWrite!((path, rev) => {
      if (rev === undefined) return; // remove: not deduped
      rotateBuckets();
      const key = dedupKey('set', path, rev);
      if (key !== null) bucketCurrent.add(key);
    });
  }

  function teardown() {
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
    if (selfWriteUnsub) {
      selfWriteUnsub();
      selfWriteUnsub = null;
    }
  }

  if (signal.aborted) {
    teardown();
    return;
  }
  signal.addEventListener('abort', teardown, { once: true });

  // ── Drive loop ──
  (async () => {
    let attempt = 0;
    while (!signal.aborted) {
      let endedWithError = false;
      try {
        const stream = tree.watch!({ kind: 'all' }, { signal });
        for await (const event of stream) {
          if (signal.aborted) return;
          attempt = 0;

          if (event.type === 'reconnect') {
            if (!event.preserved && invalidateCacheAll) invalidateCacheAll();
            forwardEvent(event);
            continue;
          }

          // Repath BEFORE dedup: onSelfWrite fires from withSubscriptions
          // (outside the repath wrapper) in outer-namespace; the change
          // stream is inner-namespace. Keys must match in one namespace.
          const externalPath = repath(pathPrefix, event.path);
          const rev = eventRev(event);
          const key = dedupKey(event.type, externalPath, rev);
          if (dedupEnabled && key !== null && isRecent(key)) continue;

          // Cache must be fresh BEFORE forward — watch-filter reads the
          // store synchronously to compute ACL on the event.
          if (invalidateCachePath) invalidateCachePath(externalPath);

          if (event.type === 'set') {
            forwardEvent({ type: 'set', path: externalPath, node: event.node });
          } else if (event.type === 'patch') {
            forwardEvent({ type: 'patch', path: externalPath, patches: event.patches, rev: event.rev });
          } else {
            forwardEvent({ type: 'remove', path: externalPath });
          }
        }
        // Clean end: source already emitted reconnect if it needed one.
      } catch (err) {
        if (signal.aborted) return;
        endedWithError = true;
        console.error(`[external-watch:${source}] stream error, will retry:`, err);
      }
      if (signal.aborted) return;

      if (endedWithError) {
        // Clear cache BEFORE reconnect: a concurrent watch-filter read
        // would otherwise see stale pre-error data.
        if (invalidateCacheAll) invalidateCacheAll();
        // Downstream, WatchManager.notify treats this frame as a continuity
        // break: every user's resume epoch re-mints, so no pre-break cursor
        // can resume "covered" over writes we never saw (core-anz4.11).
        forwardEvent({ type: 'reconnect', preserved: false });
      }

      const delay = Math.min(maxRetryMs, initialRetryMs * 2 ** attempt);
      attempt++;
      await new Promise<void>((resolve) => {
        let onAbort: (() => void) | null = null;
        const t = setTimeout(() => {
          // Detach abort listener — without this, listeners accumulate
          // over long-running retry cycles.
          if (onAbort) signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        if (typeof t.unref === 'function') t.unref();
        onAbort = () => { clearTimeout(t); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  })().catch((err) => {
    console.error(`[external-watch:${source}] loop crashed:`, err);
    teardown();
  });
}
