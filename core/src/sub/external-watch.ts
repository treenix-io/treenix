// Treenix External Watch — pumps an outside Tree's watch stream into the
// subscription bus, with dedup of in-pipeline self-writes.
//
// Use case: a mount adapter exposes Tree.watch over an external source
// (Mongo change streams, FS watch, REST webhook, ...). Writes that flow
// through withSubscriptions already produce events for SSE; the same writes,
// observed by the external source, would surface a SECOND time. This module
// runs the consumer loop, repaths events into the outer (caller) namespace,
// deduplicates self-writes, and forwards through to the subscription bus.
//
// Lifecycle: caller owns an AbortController. Cleanup runs on abort:
//   - the underlying Tree.watch stream closes (signal propagation)
//   - the onSelfWrite subscription unsubscribes
//   - the bucket-rotation timer clears
//
// Errors / stream end: the loop forwards `reconnect{preserved:false}` to
// the bus so SSE clients refetch, then reconnects with exponential backoff.
// On natural stream end (e.g. Mongo invalidate), no extra reconnect is sent
// — the source already produced one before closing.

import type { Tree, TreeEvent } from '#tree';
import type { OnSelfWrite } from './index';

export type RunExternalWatchOpts = {
  /** Prepended to every yielded event.path before forwarding. For an unrepathed
   *  mount (mount.shared = true) pass '/' to no-op. */
  pathPrefix: string;
  /** Where to forward the (repathed, deduped) event. Usually `watcher.notify`. */
  forwardEvent: (event: TreeEvent) => void;
  /** Invalidate the outer cache for a path before forwarding the event.
   *  External writes bypass `withCache.set`, so without this call any
   *  consumer (e.g. watch-filter computing ACL via `baseStore.get`) would
   *  read the stale cached node. Invoked for set/patch/remove on the
   *  REPATHED (outer namespace) path. */
  invalidateCachePath?: (outerPath: string) => void;
  /** Clear the entire outer cache. Invoked on reconnect{preserved:false}
   *  from the source (e.g. Mongo invalidate, stream error after retry).
   *  Coarse but safe — clients refetch anyway. */
  invalidateCacheAll?: () => void;
  /** Subscribe to self-write notifications from withSubscriptions. Required
   *  when `dedupWindowMs > 0`. The consumer subscribes on start and unsubs
   *  on abort. */
  onSelfWrite?: OnSelfWrite;
  /** TTL window (ms) for self-write dedup. 0 or undefined = no dedup. The
   *  implementation rotates two buckets every `dedupWindowMs`, so entries
   *  live for `[dedupWindowMs, 2 * dedupWindowMs)` before eviction. */
  dedupWindowMs?: number;
  /** Aborts the loop, closes the inner stream, clears rotation timer,
   *  unsubscribes self-writes. */
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
  // Remove events are NEVER deduped — there's no stable identity to key on
  // (no $rev). Path-only would falsely suppress this sequence:
  //   1. Treenix removes /x
  //   2. External writer creates /x
  //   3. External writer removes /x
  // The dedup buffer still holds `R:/x` from step 1, so step 3 would be
  // suppressed and clients would believe /x still exists. Duplicate remove
  // events are idempotent on the client side; false suppression is not.
  if (type === 'remove') return null;
  return `S:${path}@${rev ?? '?'}`;
}

/**
 * Start a consumer loop that pumps `tree.watch` into `forwardEvent`.
 * Fire-and-forget: caller owns `signal` for shutdown. Throws synchronously
 * if `tree.watch` is undefined or if dedup is requested without `onSelfWrite`.
 */
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

  function isRecent(key: string): boolean {
    return bucketCurrent.has(key) || bucketPrevious.has(key);
  }

  if (dedupEnabled) {
    rotateTimer = setInterval(() => {
      bucketPrevious = bucketCurrent;
      bucketCurrent = new Set();
    }, dedupWindowMs);
    if (typeof rotateTimer.unref === 'function') rotateTimer.unref();

    selfWriteUnsub = onSelfWrite!((path, rev) => {
      // Only mark set/patch — removes are never deduped (see dedupKey()).
      // withSubscriptions emits rev=undefined for remove events; we skip
      // those here.
      if (rev === undefined) return;
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
          attempt = 0; // any successful event resets the backoff

          // Control events pass through unchanged (reconnect from the
          // source — e.g. Mongo invalidate — already tells clients to refetch).
          // Also clear the outer cache: state is wholesale stale, the next
          // read MUST go through to the source.
          if (event.type === 'reconnect') {
            if (!event.preserved && invalidateCacheAll) invalidateCacheAll();
            forwardEvent(event);
            continue;
          }

          // Dedup AFTER repath: onSelfWrite fires from withSubscriptions which
          // sits OUTSIDE the repath wrapper, so its keys are in the outer
          // (caller) namespace. The change stream produces inner-namespace
          // paths. Repath first, then key match.
          const externalPath = repath(pathPrefix, event.path);
          const rev = eventRev(event);
          const key = dedupKey(event.type, externalPath, rev);
          // key === null → never dedup (remove events, see dedupKey rationale).
          if (dedupEnabled && key !== null && isRecent(key)) continue;

          // Invalidate cache BEFORE forwarding. ACL filters and other
          // consumers read the store synchronously when handling the event;
          // they MUST see fresh data, not the pre-write cached value.
          if (invalidateCachePath) invalidateCachePath(externalPath);

          if (event.type === 'set') {
            forwardEvent({ type: 'set', path: externalPath, node: event.node });
          } else if (event.type === 'patch') {
            forwardEvent({ type: 'patch', path: externalPath, patches: event.patches, rev: event.rev });
          } else {
            forwardEvent({ type: 'remove', path: externalPath });
          }
        }
        // Stream ended cleanly — source already emitted reconnect (if it
        // wanted clients to refetch). Don't duplicate.
      } catch (err) {
        if (signal.aborted) return;
        endedWithError = true;
        console.error(`[external-watch:${source}] stream error, will retry:`, err);
      }
      if (signal.aborted) return;

      if (endedWithError) {
        // Server-side cache MUST be cleared first — any reader (e.g. the
        // watch-filter computing ACL via baseStore.get) that races with this
        // recovery path would otherwise see stale pre-error data. Then tell
        // clients to refetch.
        if (invalidateCacheAll) invalidateCacheAll();
        forwardEvent({ type: 'reconnect', preserved: false });
      }

      const delay = Math.min(maxRetryMs, initialRetryMs * 2 ** attempt);
      attempt++;
      await new Promise<void>((resolve) => {
        let onAbort: (() => void) | null = null;
        const t = setTimeout(() => {
          // Normal completion — detach abort listener so listeners don't
          // accumulate over many retry cycles.
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
