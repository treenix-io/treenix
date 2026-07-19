// Per-site pins (ns6p.4 r2-F1/F5): the formerly door-bypassing production
// sites — EditorSidebar listings + chrome gets, RoutedPage resolve, ActionCards
// post-execute refresh — now read through the tracked door and count their
// server holds in the tab-global registry. Each pin exercises behavior only
// the door provides (absence ordering / reconverge / hold co-counting).

import type { NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

type WirePage = { items: NodeData[]; total: number; truncated?: boolean; nextCursor?: string };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const getCalls: Record<string, unknown>[] = [];
const getChildrenCalls: Record<string, unknown>[] = [];
const resolveCalls: Record<string, unknown>[] = [];
const unwatchCalls: Record<string, unknown>[] = [];
const unwatchChildrenCalls: Record<string, unknown>[] = [];

const getResults: (NodeData | null | Promise<NodeData | null>)[] = [];
const childrenPages: (WirePage | Promise<WirePage>)[] = [];
const resolveResults: (NodeData[] | Promise<NodeData[]>)[] = [];

const getQuery = mock.fn(async (input: Record<string, unknown>) => {
  getCalls.push(input);
  const n = getResults.shift();
  if (n === undefined) throw new Error('get called with no scripted node');
  return n;
});
const getChildrenQuery = mock.fn(async (input: Record<string, unknown>) => {
  getChildrenCalls.push(input);
  const page = childrenPages.shift();
  if (!page) throw new Error('getChildren called with no scripted page');
  return page;
});
const resolveQuery = mock.fn(async (input: Record<string, unknown>) => {
  resolveCalls.push(input);
  const r = resolveResults.shift();
  if (!r) throw new Error('resolve called with no scripted result');
  return r;
});
const unwatchMutate = mock.fn(async (i: Record<string, unknown>) => { unwatchCalls.push(i); });
const unwatchChildrenMutate = mock.fn(async (i: Record<string, unknown>) => { unwatchChildrenCalls.push(i); });

mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: getQuery },
      getChildren: { query: getChildrenQuery },
      resolve: { query: resolveQuery },
      patch: { mutate: async () => {} },
      set: { mutate: async () => {} },
      remove: { mutate: async () => {} },
      execute: { mutate: async () => undefined },
      unwatch: { mutate: unwatchMutate },
      unwatchChildren: { mutate: unwatchChildrenMutate },
      getPerm: { query: async () => 0 },
    },
    getToken: () => null,
    setToken: () => {},
    clearToken: () => {},
    AUTH_EXPIRED_EVENT: 'trpc:auth-expired',
    TAB_TOKEN: 'test-tab',
    tabTokenInput: { token: 'test-tab' },
  },
});

const cache = await import('#tree/cache');
const holds = await import('#tree/holds');
const { cancelReadReconverges } = await import('#tree/read-track');
// EditorSidebar/ActionCards consume these shared one-shot helpers — their
// component modules pull .tsx-only '#' specifiers node cannot resolve, so the
// pins land on the helpers themselves (mock-level per the audit).
const {
  acquireResponseHold,
  createClientTreeSource,
  loadListingOnce,
  loadWatchedListing,
  refreshWatchedNode,
  releaseWatchedListings,
  trackedWatchGet,
} = await import('./client-tree-source');
const { resolveRouteTracked } = await import('../app/RoutedPage');
const { watch } = await import('#hooks');

const node = (path: string, rev?: number, v?: string): NodeData =>
  rev === undefined ? { $path: path, $type: 'doc', v } : { $path: path, $type: 'doc', $rev: rev, v };

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Event-driven wait on a single path's cache state. */
function waitPath(path: string, pred: () => boolean): Promise<void> {
  return new Promise((res) => {
    const check = () => { if (pred()) { unsub(); res(); } };
    const unsub = cache.subscribePath(path, check);
    check();
  });
}

/** Event-driven wait on a parent's children state. */
function waitChildren(parent: string, pred: () => boolean): Promise<void> {
  return new Promise((res) => {
    const check = () => { if (pred()) { unsub(); res(); } };
    const unsub = cache.subscribeChildren(parent, check);
    check();
  });
}

beforeEach(() => {
  cache.clear();
  holds.resetHolds();
  getCalls.length = 0;
  getChildrenCalls.length = 0;
  resolveCalls.length = 0;
  unwatchCalls.length = 0;
  unwatchChildrenCalls.length = 0;
  getResults.length = 0;
  childrenPages.length = 0;
  resolveResults.length = 0;
});

afterEach(() => cancelReadReconverges());

describe('loadWatchedListing (EditorSidebar site) — door + registry (r2-F1/F5)', () => {
  it('registers live with the tab token, settles the shared window, and counts every hold it took', async () => {
    childrenPages.push({ items: [node('/sb/a'), node('/sb/b')], total: 2 });
    // Inspector-style co-hold on one child BEFORE the sidebar loads.
    holds.acquireHold('/sb/a');

    const acquired = await loadWatchedListing('/sb');

    assert.deepEqual(getChildrenCalls[0], { path: '/sb', watch: true, watchNew: true, token: 'test-tab' });
    assert.deepEqual(acquired, ['/sb/a', '/sb/b']);
    assert.deepEqual(cache.getChildren('/sb').map((n) => n.$path), ['/sb/a', '/sb/b']);
    assert.equal(cache.getChildrenPhase('/sb'), 'ready', 'full window settle — no stranded phase');

    // Collapse-style release: the co-held child's server hold must survive.
    holds.releaseChildrenHold('/sb');
    holds.releaseHolds(acquired);
    assert.deepEqual(unwatchChildrenCalls, [{ paths: ['/sb'], token: 'test-tab' }]);
    assert.deepEqual(unwatchCalls, [{ paths: ['/sb/b'], token: 'test-tab' }],
      "sidebar collapse must not strip the Inspector's hold on /sb/a");

    holds.releaseHold('/sb/a');
    assert.deepEqual(unwatchCalls[1], { paths: ['/sb/a'], token: 'test-tab' });
  });

  it('a remove landing mid-listing reconverges through the door lane', async () => {
    const d = deferred<WirePage>();
    childrenPages.push(d.promise, { items: [node('/sd/a')], total: 1 });

    const p = loadWatchedListing('/sd');
    await flush(); // listing in flight

    // Remove event: membership overlap on the parent (what applyDataEvent does).
    cache.flagChildrenReadOverlap('/sd');
    cache.remove('/sd/b');

    d.resolve({ items: [node('/sd/a'), node('/sd/b')], total: 2 });
    await p;
    assert.ok(cache.getChildren('/sd').some((n) => n.$path === '/sd/b'), 'stale page authoritative for the moment');

    await new Promise<void>((res) => {
      const healed = () => getChildrenCalls.length === 2
        && !cache.getChildren('/sd').some((n) => n.$path === '/sd/b');
      const unsub = cache.subscribeChildren('/sd', () => { if (healed()) { unsub(); res(); } });
      if (healed()) { unsub(); res(); }
    });
  });

  it('trackedWatchGet: watch-registering tracked get — an eviction mid-flight is not resurrected', async () => {
    const d = deferred<NodeData | null>();
    getResults.push(d.promise, null);

    const p = trackedWatchGet('/root');
    await flush();
    assert.deepEqual(getCalls[0], { path: '/root', watch: true, token: 'test-tab' });

    cache.flagPathReadOverlap('/root');
    cache.remove('/root');

    d.resolve(node('/root', 1, 'zombie'));
    await p;
    assert.equal(cache.get('/root'), undefined, 'door-bypassing put would have resurrected the node');
  });
});

describe('RoutedPage.resolveRouteTracked — door routing (r2-F1)', () => {
  it('carries watch+token, caches route and target through ingest', async () => {
    resolveResults.push([
      { $path: '/sys/routes/x', $type: 'ref', $ref: '/pages/x' },
      node('/pages/x', 3, 'target'),
    ]);

    const arr = await resolveRouteTracked('/sys/routes/x');

    assert.deepEqual(resolveCalls[0], { path: '/sys/routes/x', watch: true, token: 'test-tab' });
    assert.equal(arr.length, 2);
    assert.ok(cache.get('/sys/routes/x'), 'route cached');
    assert.equal((cache.get('/pages/x') as { v?: string } | undefined)?.v, 'target', 'target cached');
  });

  it('a route-path eviction mid-resolve is not resurrected by the older response', async () => {
    const d = deferred<NodeData[]>();
    resolveResults.push(d.promise);

    const p = resolveRouteTracked('/sys/routes/y');
    await flush();

    cache.flagPathReadOverlap('/sys/routes/y');
    cache.remove('/sys/routes/y');

    d.resolve([node('/sys/routes/y', 1, 'stale-route')]);
    const arr = await p;

    assert.equal(arr.length, 1, 'result still returned to the caller');
    assert.equal(cache.get('/sys/routes/y'), undefined, 'stale route image must not re-enter the cache');
  });
});

describe('refreshWatchedNode (ActionCards site) — door + transient hold (r2-F1/F5)', () => {
  it('tracked watch-get; alone → the transient hold releases the registration (no leak)', async () => {
    getResults.push(node('/act', 2, 'fresh'));

    await refreshWatchedNode('/act');

    assert.deepEqual(getCalls[0], { path: '/act', watch: true, token: 'test-tab' });
    assert.equal((cache.get('/act') as { v?: string } | undefined)?.v, 'fresh');
    assert.deepEqual(unwatchCalls, [{ paths: ['/act'], token: 'test-tab' }],
      'nobody else holds the path — the get\'s registration is released');
  });

  it('co-held path: the refresh leaves the Inspector\'s hold untouched', async () => {
    holds.acquireHold('/act2');
    getResults.push(node('/act2', 1, 'v'));

    await refreshWatchedNode('/act2');

    assert.equal(unwatchCalls.length, 0, 'transient hold must not strip the live consumer');
    holds.releaseHold('/act2');
    assert.deepEqual(unwatchCalls, [{ paths: ['/act2'], token: 'test-tab' }]);
  });

  it('an older refresh image cannot regress a newer cached node (ingest routing)', async () => {
    cache.put(node('/act3', 5, 'newer'));
    getResults.push(node('/act3', 1, 'stale'));

    await refreshWatchedNode('/act3');

    assert.equal(cache.get('/act3')?.$rev, 5, 'raw put would have regressed the node');
  });
});

describe('loadListingOnce (MiniTree site) — unwatched door listing (r3-F1b)', () => {
  it('an old page cannot erase a create applied mid-flight — the door reconverges', async () => {
    // Co-mounted live listing's authoritative pre-create window.
    cache.replaceChildren('/mt', [node('/mt/a')]);
    const d = deferred<WirePage>();
    childrenPages.push(d.promise, { items: [node('/mt/a'), node('/mt/new')], total: 2 });

    const p = loadListingOnce('/mt');
    await flush(); // MiniTree page in flight

    // Create event lands (what applyDataEvent does): membership overlap + node.
    cache.flagChildrenReadOverlap('/mt');
    cache.put(node('/mt/new'));

    d.resolve({ items: [node('/mt/a')], total: 1 }); // page fetched pre-create
    await p;
    assert.ok(!cache.getChildren('/mt').some((n) => n.$path === '/mt/new'),
      'stale page authoritative for the moment');

    // The raw replaceChildren path erased the create FOREVER; the door heals.
    await new Promise<void>((res) => {
      const healed = () => getChildrenCalls.length === 2
        && cache.getChildren('/mt').some((n) => n.$path === '/mt/new');
      const unsub = cache.subscribeChildren('/mt', () => { if (healed()) { unsub(); res(); } });
      if (healed()) { unsub(); res(); }
    });
  });

  it('registers nothing: no watch flags, no tab token, no holds', async () => {
    childrenPages.push({ items: [node('/mp/x')], total: 1 });

    await loadListingOnce('/mp');

    assert.deepEqual(getChildrenCalls[0], { path: '/mp' }, 'unwatched read must not carry live-registration inputs');
    assert.deepEqual(cache.getChildren('/mp').map((n) => n.$path), ['/mp/x']);
    assert.equal(cache.getChildrenPhase('/mp'), 'ready', 'full window settle — no stranded phase');
  });
});

describe('holds acquire before the awaited registration (r3-F2)', () => {
  it('watch(): co-consumer release during the registering get sends no unwatch', async () => {
    holds.acquireHold('/f2w'); // Inspector-style co-consumer
    const d = deferred<NodeData | null>();
    getResults.push(d.promise);

    const gen = watch('/f2w');
    const first = gen.next(); // issues the registering get (eager count taken)
    await flush();

    holds.releaseHold('/f2w'); // co-consumer leaves mid-flight
    assert.equal(unwatchCalls.length, 0, 'the eager count must keep the server hold alive');

    d.resolve(node('/f2w', 1));
    await first;
    await gen.return(undefined);
    assert.deepEqual(unwatchCalls, [{ paths: ['/f2w'], token: 'test-tab' }], 'last consumer releases exactly once');
  });

  it('loadWatchedListing: co-consumer children release during the registering listing sends no unwatchChildren', async () => {
    holds.acquireChildrenHold('/f2l'); // e.g. a useChildren({watch}) mount
    const d = deferred<WirePage>();
    childrenPages.push(d.promise);

    const p = loadWatchedListing('/f2l');
    await flush();

    holds.releaseChildrenHold('/f2l'); // mount unmounts mid-flight
    assert.equal(unwatchChildrenCalls.length, 0, 'the eager count must keep the prefix hold alive');

    d.resolve({ items: [], total: 0 });
    await p;
    holds.releaseChildrenHold('/f2l'); // listing consumer leaves — now zero
    assert.deepEqual(unwatchChildrenCalls, [{ paths: ['/f2l'], token: 'test-tab' }]);
  });

  it('release-to-zero then immediate re-register: the get is issued only after the in-flight unwatch settles', async () => {
    const wire = deferred<void>();
    unwatchMutate.mock.mockImplementationOnce(async (i: Record<string, unknown>) => {
      unwatchCalls.push(i);
      await wire.promise;
    });
    holds.acquireHold('/rz');
    holds.releaseHold('/rz'); // → zero → unwatch fired, held open on the wire
    assert.equal(unwatchCalls.length, 1);

    getResults.push(node('/rz', 1));
    const gen = watch('/rz'); // immediate re-acquire + re-register
    const first = gen.next();
    await flush();
    assert.equal(getCalls.length, 0, 'registration must be serialized after the in-flight unwatch');

    wire.resolve();
    await first;
    assert.deepEqual(getCalls[0], { path: '/rz', watch: true, token: 'test-tab' },
      'unwatch settled first, then the re-registration');
    await gen.return(undefined);
  });

  it('registration failure under a co-consumer releases only the eager count — the co-held hold survives', async () => {
    holds.acquireHold('/f2e'); // co-consumer
    getQuery.mock.mockImplementationOnce(async () => { throw new Error('FORBIDDEN'); });

    const gen = watch('/f2e');
    await assert.rejects(() => gen.next(), /FORBIDDEN/);

    assert.equal(unwatchCalls.length, 0, 'failure release must not strip the co-consumer');
    holds.releaseHold('/f2e');
    assert.deepEqual(unwatchCalls, [{ paths: ['/f2e'], token: 'test-tab' }]);
  });
});

describe('mount registrations ride the gate (r4-F1)', () => {
  it('mountPath: dispose→immediate remount serializes the registering get after the in-flight unwatch; the remount stays live', async () => {
    const source = createClientTreeSource();
    getResults.push(node('/m1', 1));
    const h1 = source.mountPath('/m1');
    await waitPath('/m1', () => cache.get('/m1')?.$rev === 1);
    assert.deepEqual(getCalls[0], { path: '/m1', watch: true, token: 'test-tab' });

    // Dispose: the unwatch fires and is held open on the wire.
    const wire = deferred<void>();
    unwatchMutate.mock.mockImplementationOnce(async (i: Record<string, unknown>) => {
      unwatchCalls.push(i);
      await wire.promise;
    });
    h1.dispose();
    assert.deepEqual(unwatchCalls, [{ paths: ['/m1'], token: 'test-tab' }]);

    // Immediate remount: the registering get must NOT race the unwatch —
    // landing after it server-side would delete the NEW hold while the local
    // count stays positive (never observes again).
    getResults.push(node('/m1', 2));
    const h2 = source.mountPath('/m1');
    await flush();
    assert.equal(getCalls.length, 1, 'registration must wait for the in-flight unwatch');

    wire.resolve();
    await waitPath('/m1', () => cache.get('/m1')?.$rev === 2);
    assert.deepEqual(getCalls[1], { path: '/m1', watch: true, token: 'test-tab' },
      'unwatch settled first, then the re-registration');

    // The mounted consumer still observes events on the re-established hold.
    let notified = false;
    const unsub = cache.subscribePath('/m1', () => { notified = true; });
    cache.put(node('/m1', 3));
    assert.ok(notified, 'consumer receives a subsequent event');
    unsub();

    h2.dispose();
    assert.equal(unwatchCalls.length, 2, 'the remount held exactly one count — released exactly once');
  });

  it('mountChildren: dispose→immediate remount serializes the registering listing after the in-flight unwatchChildren', async () => {
    const source = createClientTreeSource();
    childrenPages.push({ items: [node('/m2/a')], total: 1 });
    const h1 = source.mountChildren('/m2', { watch: true, watchNew: true });
    await waitChildren('/m2', () => cache.getChildrenPhase('/m2') === 'ready');
    assert.equal(getChildrenCalls[0].token, 'test-tab');

    const wire = deferred<void>();
    unwatchChildrenMutate.mock.mockImplementationOnce(async (i: Record<string, unknown>) => {
      unwatchChildrenCalls.push(i);
      await wire.promise;
    });
    h1.dispose();
    assert.deepEqual(unwatchChildrenCalls, [{ paths: ['/m2'], token: 'test-tab' }]);

    childrenPages.push({ items: [node('/m2/a'), node('/m2/b')], total: 2 });
    const h2 = source.mountChildren('/m2', { watch: true, watchNew: true });
    await flush();
    assert.equal(getChildrenCalls.length, 1, 'registering listing must wait for the in-flight unwatchChildren');

    wire.resolve();
    await waitChildren('/m2', () => getChildrenCalls.length === 2
      && cache.getChildren('/m2').some((n) => n.$path === '/m2/b'));
    assert.equal(getChildrenCalls[1].watchNew, true, 'unwatchChildren settled first, then the re-registration');

    h2.dispose();
    assert.equal(unwatchChildrenCalls.length, 2, 'the remount held exactly one children count');
  });
});

describe('response-derived holds re-register over an in-flight unwatch (r4-F1)', () => {
  it("co-holder's last release during the resolve → the target hold is re-established once the unwatch settles", async () => {
    // Co-holder (usePath-style) held the target when the resolve was issued…
    holds.acquireHold('/pg/t');
    // …and released while it rode the wire: the unwatch may land server-side
    // AFTER the resolve registered the target — deleting the fresh hold.
    const wire = deferred<void>();
    unwatchMutate.mock.mockImplementationOnce(async (i: Record<string, unknown>) => {
      unwatchCalls.push(i);
      await wire.promise;
    });
    holds.releaseHold('/pg/t');
    assert.equal(unwatchCalls.length, 1);

    // Response arrives: RoutedPage counts the response-derived target.
    acquireResponseHold('/pg/t');
    await flush();
    assert.equal(getCalls.length, 0, 'the re-register is serialized after the unwatch, never concurrent');

    getResults.push(node('/pg/t', 2));
    wire.resolve();
    await flush();
    await flush();
    assert.deepEqual(getCalls, [{ path: '/pg/t', watch: true, token: 'test-tab' }],
      'the acquire detected the in-flight unwatch and re-registered through the door');
    assert.equal(cache.get('/pg/t')?.$rev, 2, 'the re-get landed through the door');
    assert.equal(unwatchCalls.length, 1, 'the transient guard count released without stripping the consumer');

    // The consumer (RoutedPage) is still the sole holder — its release fires.
    holds.releaseHold('/pg/t');
    assert.deepEqual(unwatchCalls[1], { paths: ['/pg/t'], token: 'test-tab' });
  });

  it('no in-flight unwatch → the acquire issues no extra request', async () => {
    acquireResponseHold('/pg/q');
    await flush();
    assert.equal(getCalls.length, 0, 'a clean acquire must not re-register (wasted round trip)');
    holds.releaseHold('/pg/q');
    assert.deepEqual(unwatchCalls, [{ paths: ['/pg/q'], token: 'test-tab' }]);
  });

  it('every consumer left while the unwatch was in flight → no re-register (their release IS the truth)', async () => {
    holds.acquireHold('/pg/x');
    const wire = deferred<void>();
    unwatchMutate.mock.mockImplementationOnce(async (i: Record<string, unknown>) => {
      unwatchCalls.push(i);
      await wire.promise;
    });
    holds.releaseHold('/pg/x');

    acquireResponseHold('/pg/x');
    holds.releaseHold('/pg/x'); // fast navigation: RoutedPage cancelled → released
    assert.equal(unwatchCalls.length, 2, 'the abandoning release fired its own unwatch');

    wire.resolve();
    await flush();
    assert.equal(getCalls.length, 0, 're-registering an abandoned path would leak a server hold');
  });
});

describe('releaseWatchedListings — sidebar sweep on unmount/root switch (r4-F2)', () => {
  it('releases children + item holds of every live listing, batched; a co-held item survives', async () => {
    childrenPages.push({ items: [node('/sw/a/x'), node('/sw/a/y')], total: 2 });
    childrenPages.push({ items: [node('/sw/b/z')], total: 1 });
    const ledger = new Map<string, string[]>();
    ledger.set('/sw/a', await loadWatchedListing('/sw/a'));
    ledger.set('/sw/b', await loadWatchedListing('/sw/b'));
    holds.acquireHold('/sw/a/x'); // Inspector-style co-hold (usePath)

    releaseWatchedListings(ledger);

    assert.equal(ledger.size, 0, 'the ledger is cleared');
    assert.deepEqual(unwatchChildrenCalls, [{ paths: ['/sw/a', '/sw/b'], token: 'test-tab' }],
      'one batched unwatchChildren for all swept dirs');
    assert.deepEqual(unwatchCalls, [{ paths: ['/sw/a/y', '/sw/b/z'], token: 'test-tab' }],
      "the sweep must not strip the Inspector's hold on /sw/a/x");

    holds.releaseHold('/sw/a/x');
    assert.deepEqual(unwatchCalls[1], { paths: ['/sw/a/x'], token: 'test-tab' });
  });

  it('sweeps unheld strays (autoWatch promotions born while live); held strays survive', async () => {
    childrenPages.push({ items: [node('/sw2/d/i')], total: 1 });
    const ledger = new Map([['/sw2/d', await loadWatchedListing('/sw2/d')]]);
    // SSE-born children the listing never counted; one is held by an Inspector.
    cache.appendChildren('/sw2/d', [node('/sw2/d/born'), node('/sw2/d/held')]);
    holds.acquireHold('/sw2/d/held');

    releaseWatchedListings(ledger);

    assert.deepEqual(unwatchChildrenCalls, [{ paths: ['/sw2/d'], token: 'test-tab' }]);
    assert.deepEqual(unwatchCalls[0], { paths: ['/sw2/d/i'], token: 'test-tab' });
    assert.deepEqual(unwatchCalls[1], { paths: ['/sw2/d/born'], token: 'test-tab' },
      'unheld stray swept; the held one survives');

    holds.releaseHold('/sw2/d/held');
    assert.deepEqual(unwatchCalls[2], { paths: ['/sw2/d/held'], token: 'test-tab' });
  });

  it('empty ledger is a no-op', () => {
    releaseWatchedListings(new Map());
    assert.equal(unwatchCalls.length, 0);
    assert.equal(unwatchChildrenCalls.length, 0);
  });
});
