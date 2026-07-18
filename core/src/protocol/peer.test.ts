// TWP peer over loopback — protocol-core contract tests (docs/research/twp-spec.md §5).

import { createNode, R, S } from '#core';
import { OpError } from '#errors';
import type { ResolvedReadPlan } from '#mount/resolve-plan';
import { withAcl, type AclChildrenOpts, type PlanChildrenOpts } from '#security/acl-tree';
import { registerWatchList } from '#server/wire';
import { withSubscriptions } from '#sub';
import { createWatchManager, type StampedEvent } from '#sub/watch';
import { createMemoryTree } from '#tree';
import { relocateCtx, withStoragePolicy } from '#tree/policy';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoopback } from './loopback';
import { createPeer, type PeerServe, type ServeFactory, type ServeHooks } from './peer';

function pair(serve?: ServeFactory) {
  const [ca, cb] = createLoopback();
  const client = createPeer();
  const server = createPeer(serve);
  client.attach(ca);
  server.attach(cb);
  return { client, server };
}

async function seededTree() {
  const tree = createMemoryTree();
  await tree.set(createNode('/a', 'dir', { title: 'A' }));
  await tree.set(createNode('/a/one', 'dir', {}));
  await tree.set(createNode('/target', 'dir', { hit: true }));
  await tree.set({ $path: '/link', $type: 'ref', $ref: '/target' });
  return tree;
}

const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

describe('TWP peer over loopback', () => {
  it('fail closed: peer without serve answers FORBIDDEN', async () => {
    const { client } = pair();
    await assert.rejects(client.req.get('/a'), isCode('FORBIDDEN'));
  });

  it('get/set/patch/rm/ls roundtrip', async () => {
    const tree = await seededTree();
    const { client } = pair(() => ({ tree }));

    const node = await client.req.get('/a');
    assert.deepEqual(node, { $path: '/a', $type: 't.dir', title: 'A', $rev: 1 });

    await client.req.set('/b', { $type: 'dir', n: 1 });
    assert.deepEqual(await client.req.get('/b'), { $path: '/b', $type: 'dir', n: 1, $rev: 1 });

    await client.req.patch('/b', [['r', 'n', 2]]);
    const patched = await client.req.get('/b');
    assert.equal((patched as { n: number }).n, 2);

    const page = await client.req.ls('/') as { items: { $path: string }[]; total: number };
    assert.ok(page.items.some((n) => n.$path === '/b'));

    assert.equal(await client.req.rm('/b'), true);
    assert.equal(await client.req.get('/b'), undefined);
  });

  it('set: path field is authoritative, $path/$patches stripped from payload', async () => {
    const tree = await seededTree();
    const { client } = pair(() => ({ tree }));
    await client.req.set('/c', { $type: 'dir', $path: '/evil', $patches: [['r', 'x', 1]], v: 7 });
    assert.deepEqual(await tree.get('/c'), { $path: '/c', $type: 'dir', v: 7, $rev: 1 });
    assert.equal(await tree.get('/evil'), undefined);
  });

  // bd core-anz4.2: the node's OWN $id must never reach the store from the wire —
  // a foreign $id on a fresh path would put two live nodes on one ULID. But $refId
  // is the ref TARGET's identity (client-editable with $ref, load-bearing for
  // id-first resolution) — it must ROUND-TRIP intact.
  it('set: wire strips foreign $id but preserves client $refId', async () => {
    const policy = withStoragePolicy(createMemoryTree());
    const { client } = pair(() => ({ tree: policy.tree }));

    const FOREIGN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const TARGET_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
    await client.req.set('/aref', { $type: 'ref', $ref: '/target', $refId: TARGET_ID, $id: FOREIGN, v: 1 });

    const stored = await policy.tree.get('/aref');
    assert.ok(stored, 'node stored');
    assert.equal(typeof stored.$id, 'string', 'server minted an identity');
    assert.notEqual(stored.$id, FOREIGN, 'foreign $id discarded');
    assert.equal(stored.$refId, TARGET_ID, 'client $refId round-trips to storage');
    assert.equal((await client.req.get('/aref') as { v: number }).v, 1, 'data fields preserved');
  });

  it('set without $id over the wire mints normally', async () => {
    const policy = withStoragePolicy(createMemoryTree());
    const { client } = pair(() => ({ tree: policy.tree }));

    await client.req.set('/plain', { $type: 'dir', v: 2 });

    const stored = await policy.tree.get('/plain');
    assert.ok(stored?.$id, 'fresh id minted');
    assert.equal((await client.req.get('/plain') as { v: number }).v, 2);
  });

  it('server-side set under relocateCtx preserves a carried $id (core-anz4.2)', async () => {
    const policy = withStoragePolicy(createMemoryTree());

    const CARRIED = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
    await policy.tree.set({ $path: '/restored', $type: 'dir', $id: CARRIED }, relocateCtx());

    assert.equal((await policy.tree.get('/restored'))?.$id, CARRIED, 'move/restore path keeps identity');
  });

  it('set without $type → BAD_REQUEST', async () => {
    const tree = await seededTree();
    const { client } = pair(() => ({ tree }));
    await assert.rejects(client.req.set('/c', { v: 1 }), isCode('BAD_REQUEST'));
  });

  it('resolve follows refs: [requested, ...resolved]', async () => {
    const tree = await seededTree();
    const { client } = pair(() => ({ tree }));
    const out = await client.req.resolve('/link') as { $path: string }[];
    assert.deepEqual(out.map((n) => n.$path), ['/link', '/target']);
    assert.deepEqual(await client.req.resolve('/missing'), []);
  });

  it('resolve follows moved tombstones to the live node (core-gk8.10 stage 2)', async () => {
    const tree = await seededTree();
    // Simulate move(): live node at the new path, tombstone at the old.
    await tree.set(createNode('/home', 'dir', { hit: true }));
    await tree.set({ $path: '/target', $type: 'moved', $ref: '/home' });

    const { client } = pair(() => ({ tree }));
    const out = await client.req.resolve('/link') as { $path: string }[];
    assert.deepEqual(out.map((n) => n.$path), ['/link', '/home'], 'client receives the live node, not the tombstone');
  });

  it('resolve degrades to [node] on missing target or broken chain', async () => {
    const tree = await seededTree();
    await tree.set({ $path: '/dangling', $type: 'ref', $ref: '/nowhere' });
    // Identity mismatch: the tombstone belongs to a DIFFERENT node's move.
    await tree.set({ $path: '/link2', $type: 'ref', $ref: '/t2', $refId: 'id-A' });
    await tree.set({ $path: '/t2', $type: 'moved', $ref: '/target', $id: 'id-B' });
    const { client } = pair(() => ({ tree }));

    const dangling = await client.req.resolve('/dangling') as { $path: string }[];
    assert.deepEqual(dangling.map((n) => n.$path), ['/dangling']);

    const originalError = console.error;
    let logged = false;
    console.error = () => { logged = true; };
    try {
      const mismatched = await client.req.resolve('/link2') as { $path: string }[];
      assert.deepEqual(mismatched.map((n) => n.$path), ['/link2'], 'broken chain resolves best-effort to the ref alone');
    } finally {
      console.error = originalError;
    }
    assert.ok(logged, 'broken chain is logged, not silent');
  });

  it('ls query threads to the tree; malformed query/cursor and query+watch combos are rejected (core-92z)', async () => {
    const tree = await seededTree();
    const { client } = pair(() => ({ tree }));

    const page = await client.req.ls('/', { query: { title: 'A' } }) as { items: { $path: string }[] };
    assert.deepEqual(page.items.map((n) => n.$path), ['/a']);

    // wire-shape guards
    await assert.rejects(client.req.ls('/', { query: 5 as unknown as Record<string, unknown> }), isCode('BAD_REQUEST'));
    await assert.rejects(client.req.ls('/', { cursor: 7 as unknown as string }), isCode('BAD_REQUEST'));

    // Stage 6d (core-9yd): query+watch is allowed at depth-1; a DEEP query
    // watch would silently miss flips below the first level — rejected.
    await assert.rejects(client.req.ls('/', { query: { title: 'A' }, watchList: true, depth: 2 }), isCode('BAD_REQUEST'));
    await assert.rejects(client.req.ls('/', { query: { title: 'A' }, watch: true, depth: -1 }), isCode('BAD_REQUEST'));
  });

  it('deep ls+watchList WITHOUT query is rejected — list-watch notify is direct-parent-only (core-karx)', async () => {
    const tree = await seededTree();
    const pages: string[] = [];
    const serve: PeerServe = {
      tree: Object.assign(Object.create(tree) as typeof tree, {
        getPerm: async () => (R | S),
      }),
      hooks: {
        watch: () => {},
        unwatch: () => {},
        watchList: (path) => { pages.push(path); },
      },
    };
    const { client } = pair(() => serve);

    await assert.rejects(client.req.ls('/', { watchList: true, depth: 2 }), isCode('BAD_REQUEST'));
    await assert.rejects(client.req.ls('/', { watchList: true, depth: -1 }), isCode('BAD_REQUEST'));
    assert.deepEqual(pages, [], 'rejected registration must not reach the watchList hook');

    await client.req.ls('/', { watchList: true });
    assert.deepEqual(pages, ['/'], 'depth-1 (default) list watch stays allowed');
  });

  it('act dispatches structured fields; act without execute → BAD_REQUEST', async () => {
    const tree = await seededTree();
    const seen: unknown[] = [];
    const serve: PeerServe = {
      tree,
      execute: async (req) => { seen.push(req); return { done: req.action }; },
    };
    const { client } = pair(() => serve);

    const result = await client.req.act({ path: '/a', action: 'ship', key: 'k', data: { x: 1 }, opId: 'op-1' });
    assert.deepEqual(result, { done: 'ship' });
    assert.deepEqual(seen, [{ path: '/a', type: undefined, key: 'k', action: 'ship', data: { x: 1 }, opId: 'op-1' }]);

    const bare = pair(() => ({ tree }));
    await assert.rejects(bare.client.req.act({ path: '/a', action: 'x' }), isCode('BAD_REQUEST'));
  });

  it('act stream yields chunks and end; consumer break cancels the handler', async () => {
    const tree = await seededTree();
    let finished: () => void;
    const done = new Promise<void>((r) => { finished = r; });
    let sawAbort = false;
    const serve: PeerServe = {
      tree,
      executeStream: async function* (_req, signal) {
        signal.addEventListener('abort', () => { sawAbort = true; });
        try {
          for (let i = 0; ; i++) {
            yield i;
            await Promise.resolve();
          }
        } finally {
          // teardown arrives as gen.return() at the yield point — finally is
          // the only deterministic observation place for the handler side
          finished();
        }
      },
    };
    const { client } = pair(() => serve);

    const got: unknown[] = [];
    for await (const ch of client.req.actStream({ path: '/a', action: 'tick' })) {
      got.push(ch);
      if (got.length === 2) break;
    }
    assert.deepEqual(got, [0, 1]);
    await done;
    assert.equal(sawAbort, true);
  });

  it('act stream propagates handler errors as OpError', async () => {
    const tree = await seededTree();
    const serve: PeerServe = {
      tree,
      executeStream: async function* () {
        yield 1;
        throw new OpError('NOT_FOUND', 'gone');
      },
    };
    const { client } = pair(() => serve);
    await assert.rejects(async () => {
      for await (const _ of client.req.actStream({ path: '/a', action: 'x' })) { /* drain */ }
    }, isCode('NOT_FOUND'));
  });

  it('watch flags: S-gated registration through hooks; unsupported → BAD_REQUEST', async () => {
    const tree = await seededTree();
    const watched: string[][] = [];
    const serve: PeerServe = {
      tree: Object.assign(Object.create(tree) as typeof tree, {
        getPerm: async (p: string) => (p === '/a' ? (R | S) : R),
      }),
      hooks: {
        watch: (paths) => { watched.push(paths); },
        unwatch: () => {},
      },
    };
    const { client } = pair(() => serve);

    await client.req.get('/a', true);
    await client.req.get('/target', true); // R only — silently filtered (ACL boundary)
    assert.deepEqual(watched, [['/a']]);

    const bare = pair(async () => ({ tree }));
    await assert.rejects(bare.client.req.get('/a', true), isCode('BAD_REQUEST'));
  });

  it('sub/unsub manage watch-sets; perm returns bits', async () => {
    const tree = await seededTree();
    const calls: { op: string; paths: string[]; children?: boolean }[] = [];
    const serve: PeerServe = {
      tree: Object.assign(Object.create(tree) as typeof tree, {
        getPerm: async () => (R | S),
      }),
      hooks: {
        watch: (paths, o) => { calls.push({ op: 'watch', paths, children: o?.children }); },
        unwatch: (paths, o) => calls.push({ op: 'unwatch', paths, children: o?.children }),
      },
    };
    const { client } = pair(() => serve);

    await client.req.sub({ paths: ['/a'], prefixes: ['/a'] });
    await client.req.unsub({ paths: ['/a'] });
    assert.deepEqual(calls, [
      { op: 'watch', paths: ['/a'], children: undefined },
      { op: 'watch', paths: ['/a'], children: true },
      { op: 'unwatch', paths: ['/a'], children: undefined },
    ]);

    assert.equal(await client.req.perm('/a'), R | S);
  });

  it('events flow from server emit to client onEvent', async () => {
    const tree = await seededTree();
    const { client, server } = pair(() => ({ tree }));
    const got = new Promise((resolve) => client.onEvent(resolve));
    server.emit({ seq: 1, ev: 'set', path: '/a', node: { $type: 'dir' } });
    assert.deepEqual(await got, { seq: 1, ev: 'set', path: '/a', node: { $type: 'dir' } });
  });

  it('concurrent requests correlate by id', async () => {
    const tree = await seededTree();
    const { client } = pair(() => ({ tree }));
    const [a, one, missing] = await Promise.all([
      client.req.get('/a'),
      client.req.get('/a/one'),
      client.req.get('/nope'),
    ]);
    assert.equal((a as { $path: string }).$path, '/a');
    assert.equal((one as { $path: string }).$path, '/a/one');
    assert.equal(missing, undefined);
  });

  it('detach rejects in-flight requests', async () => {
    const tree = await seededTree();
    const [ca, cb] = createLoopback();
    const client = createPeer();
    const server = createPeer(() => ({ tree }));
    const detach = client.attach(ca);
    server.attach(cb);
    const p = client.req.get('/a');
    detach();
    await assert.rejects(p, /connection closed/);
  });

  it('bad paths are rejected at the dispatcher', async () => {
    const tree = await seededTree();
    const { client } = pair(() => ({ tree }));
    await assert.rejects(client.req.get('/a/../b'), isCode('BAD_REQUEST'));
  });

  // ── token threading (core-anz4.28, ns6p.4 slice 0) ──
  // Every watch-registering op and unsub carries the frame token into hooks —
  // registration and release must land on the same holder.

  function tokenServe(tree: Awaited<ReturnType<typeof seededTree>>) {
    const calls: { op: string; paths: string[]; token?: string; children?: boolean }[] = [];
    const listCalls: { path: string; itemWatch: boolean; token?: string }[] = [];
    const serve: PeerServe = {
      tree: Object.assign(Object.create(tree) as typeof tree, {
        getPerm: async () => (R | S),
      }),
      execute: async () => ({ $path: '/target' }),
      hooks: {
        watch: (paths, o) => { calls.push({ op: 'watch', paths, token: o?.token, children: o?.children }); },
        unwatch: (paths, o) => calls.push({ op: 'unwatch', paths, token: o?.token, children: o?.children }),
        watchList: (path, itemWatch, token) => { listCalls.push({ path, itemWatch, token }); },
      },
    };
    return { serve, calls, listCalls };
  }

  it('get/resolve/act/sub/unsub thread the frame token into hooks', async () => {
    const tree = await seededTree();
    const { serve, calls } = tokenServe(tree);
    const { client } = pair(() => serve);

    await client.req.get('/a', true, 'tok-get');
    await client.req.resolve('/link', true, 'tok-res');
    await client.req.act({ path: '/a', action: 'go', watch: true, token: 'tok-act' });
    await client.req.sub({ paths: ['/a'], prefixes: ['/a'], token: 'tok-sub' });
    await client.req.unsub({ paths: ['/a'], prefixes: ['/a'], token: 'tok-sub' });

    assert.deepEqual(calls, [
      { op: 'watch', paths: ['/a'], token: 'tok-get', children: undefined },
      { op: 'watch', paths: ['/link'], token: 'tok-res', children: undefined },
      { op: 'watch', paths: ['/target'], token: 'tok-res', children: undefined }, // followed-ref target
      { op: 'watch', paths: ['/target'], token: 'tok-act', children: undefined }, // R4-MOUNT-5 result watch
      { op: 'watch', paths: ['/a'], token: 'tok-sub', children: undefined },
      { op: 'watch', paths: ['/a'], token: 'tok-sub', children: true },
      { op: 'unwatch', paths: ['/a'], token: 'tok-sub', children: undefined },
      { op: 'unwatch', paths: ['/a'], token: 'tok-sub', children: true },
    ]);
  });

  it('ls threads the token to item watches AND the watchList hook', async () => {
    const tree = await seededTree();
    const { serve, calls, listCalls } = tokenServe(tree);
    const { client } = pair(() => serve);

    await client.req.ls('/a', { watch: true, watchList: true, token: 'tok-ls' });

    assert.deepEqual(calls, [{ op: 'watch', paths: ['/a/one'], token: 'tok-ls', children: undefined }]);
    assert.deepEqual(listCalls, [{ path: '/a', itemWatch: true, token: 'tok-ls' }]);
  });

  it('absent token stays absent (legacy hold); empty token is rejected loudly', async () => {
    const tree = await seededTree();
    const { serve, calls } = tokenServe(tree);
    const { client } = pair(() => serve);

    await client.req.get('/a', true);
    assert.deepEqual(calls, [{ op: 'watch', paths: ['/a'], token: undefined, children: undefined }]);

    // '' would alias the server-internal shared LEGACY hold — protocol error.
    await assert.rejects(client.req.get('/a', true, ''), isCode('BAD_REQUEST'));
    await assert.rejects(client.req.sub({ paths: ['/a'], token: '' }), isCode('BAD_REQUEST'));
    await assert.rejects(client.req.ls('/a', { watch: true, token: '' }), isCode('BAD_REQUEST'));

    // \0 would reach into the internal provisional-holder namespace (ns6p.4
    // invariant 27) — a guessed holder id could strip a request's coverage.
    await assert.rejects(client.req.get('/a', true, 'x\0y'), isCode('BAD_REQUEST'));
  });

  // ── ns6p.4 slice 2: watchList S-gate (invariant 22) + frozen plan (invariant 21) ──

  function aclPair(rootPerm: number) {
    const listCalls: unknown[][] = [];
    const watchCalls: string[][] = [];
    const setup = async () => {
      const store = createMemoryTree();
      await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: rootPerm }] });
      await store.set(createNode('/dir', 'dir', {}));
      await store.set(createNode('/dir/a', 'item', { status: 'open' }));
      const acl = withAcl(store, 'u1', ['public']);
      const serve: PeerServe = {
        tree: acl,
        hooks: {
          watch: (paths) => { watchCalls.push(paths); },
          unwatch: () => {},
          watchList: (...args) => { listCalls.push(args); },
        },
      };
      return { store, client: pair(() => serve).client };
    };
    return { setup, listCalls, watchCalls };
  }

  it('watchList without S on the parent → FORBIDDEN, no page, no registration (invariant 22)', async () => {
    const { setup, listCalls } = aclPair(R); // read, no subscribe
    const { client } = await setup();

    await assert.rejects(client.req.ls('/dir', { watchList: true }), isCode('FORBIDDEN'));
    assert.deepEqual(listCalls, [], 'gate fires before any registration');

    // The plain read stays available — the client re-issues without watchList.
    const page = await client.req.ls('/dir') as { items: { $path: string }[] };
    assert.equal(page.items.length, 1);
  });

  it('watchList with S registers; item-level S filtering of frame.watch is unchanged', async () => {
    const { setup, listCalls, watchCalls } = aclPair(R | S);
    const { store, client } = await setup();
    // Child grants R only — public's allow is overridden at this level, so the
    // ITEM watch is silently filtered while the LIST watch stands.
    await store.set({ ...createNode('/dir/locked', 'item', { status: 'open' }), $acl: [{ g: 'public', p: R }] });

    const page = await client.req.ls('/dir', { watchList: true, watch: true }) as { items: { $path: string }[] };
    assert.equal(page.items.length, 2, 'page carries both items');
    assert.equal(listCalls.length, 1, 'list watch registered');
    assert.deepEqual(watchCalls, [['/dir/a']], 'no-S item filtered from item watches');
  });

  it('ls{watchList}: ONE frozen plan object drives the read AND the registration (invariant 21)', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | S }] });
    await store.set(createNode('/orders', 'dir', {}));
    await store.set(createNode('/orders/a', 'item', { status: 'open' }));
    await store.set(createNode('/orders/b', 'item', { status: 'done' }));
    const acl = withAcl(store, 'u1', ['public']);

    let executed: ResolvedReadPlan | undefined;
    let registered: ResolvedReadPlan | undefined;
    const serve: PeerServe = {
      tree: Object.assign(Object.create(acl) as typeof acl, {
        getChildren: (p: string, o?: AclChildrenOpts, c?: unknown) => {
          executed = o?.plan;
          return acl.getChildren(p, o, c);
        },
      }),
      hooks: {
        watch: () => {},
        unwatch: () => {},
        watchList: (_path, _itemWatch, _token, plan) => { registered = plan; },
      },
    };
    const { client } = pair(() => serve);

    const page = await client.req.ls('/orders', { watchList: true, query: { status: 'open' } }) as { items: { $path: string }[] };
    assert.deepEqual(page.items.map((n) => n.$path), ['/orders/a'], 'the frozen plan filtered the read');
    assert.ok(executed, 'read received a pre-resolved plan');
    assert.equal(registered, executed, 'registration and read share the plan by object identity');
    assert.deepEqual(registered!.plan, { source: '/orders', callerWhere: { status: 'open' } });
  });
});

// ── ns6p.4 slice 4: server register-first (closes 0w8z W1/W2/W-get) ──
// Real WatchManager behind a hand-built ServeTree: writes injected INSIDE
// instrumented reads interleave deterministically, the lane records what a
// client's event channel receives, the journal records hook call order.

describe('register-first observe (ns6p.4 slice 4)', () => {
  const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

  async function observed(opts?: { maxWatchesPerUser?: number }) {
    const memory = createMemoryTree();
    await memory.set(createNode('/dir', 'dir', {}));
    await memory.set(createNode('/dir/a', 'item', { n: 1 }));
    const watcher = createWatchManager(opts);
    const { tree, cdc } = withSubscriptions(memory, (e) => watcher.notify(e), {
      projectMembership: async (_u, o, n) => [o, n],
    });
    watcher.bindQueryRegistry(cdc);
    const lane: StampedEvent[] = [];
    watcher.connect('c1', 'u1', (env) => lane.push(env.event), undefined, 'tab');

    const journal: string[] = [];
    const base = Object.assign(Object.create(tree) as typeof tree, {
      getPerm: async () => R | S,
    });
    const hooks: ServeHooks = {
      watch: (paths, o) => {
        journal.push(`watch:${paths.join(',')}`);
        return watcher.watch('u1', paths, o);
      },
      unwatch: (paths, o) => watcher.unwatch('u1', paths, o),
      watchList: (path, itemWatch, token, plan) => {
        journal.push(`watchList:${path}`);
        const probe = {
          planChildren: async () => {
            if (!plan) throw new Error('re-validate probe without a frozen plan');
            return plan;
          },
        };
        return registerWatchList(watcher, probe, 'u1', path, itemWatch, token, plan);
      },
      holdPrefix: (path) => {
        journal.push(`hold:${path}`);
        const release = watcher.holdPrefix('u1', path);
        return () => {
          journal.push(`release:${path}`);
          release();
        };
      },
    };
    return { memory, watcher, tree, lane, journal, base, hooks };
  }

  it('ls{watchList}: registration precedes the read — a create landing mid-scan reaches the lane (W2)', async () => {
    const h = await observed();
    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      getChildren: async (p: string, o?: AclChildrenOpts, c?: unknown) => {
        h.journal.push('read');
        const page = await h.tree.getChildren(p, o, c);
        // Lands after the scan, before the response — the old read-then-
        // register order lost this event forever (no prefix stood yet).
        await h.tree.set(createNode('/dir/mid', 'item', { n: 2 }));
        return page;
      },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    const page = await client.req.ls('/dir', { watchList: true, token: 'tab' }) as { items: { $path: string }[] };

    assert.deepEqual(page.items.map((n) => n.$path), ['/dir/a'], 'scan predates the create');
    assert.deepEqual(h.journal, ['watchList:/dir', 'read'], 'register-first call order');
    const created = h.lane.find((e) => e.type === 'set' && e.path === '/dir/mid');
    assert.ok(created, 'mid-scan create routed to the lane');
    assert.equal(typeof created.seq, 'number', 'delivered seq-stamped');
  });

  it('ls{watch} without watchList under parent-S: provisional prefix covers the scan window, then dies (invariant 27)', async () => {
    const h = await observed({ maxWatchesPerUser: 2 });
    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      getChildren: async (p: string, o?: AclChildrenOpts, c?: unknown) => {
        const page = await h.tree.getChildren(p, o, c);
        await h.tree.patch('/dir/a', [['r', 'n', 10]]); // item write mid-scan
        return page;
      },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    await client.req.ls('/dir', { watch: true, token: 'tab' });

    assert.ok(h.lane.some((e) => e.type === 'patch' && e.path === '/dir/a'),
      'mid-scan item write routed via the provisional prefix');
    assert.deepEqual(h.journal, ['hold:/dir', 'watch:/dir/a', 'release:/dir'],
      'hold → read → item watches → release');

    // Provisional gone: children routing ended with the request…
    h.lane.length = 0;
    await h.tree.set(createNode('/dir/b', 'item', { n: 3 }));
    assert.ok(!h.lane.some((e) => e.type === 'set' && e.path === '/dir/b'), 'no prefix hold survives the response');
    // …while the tab-token item hold stays live.
    await h.tree.patch('/dir/a', [['r', 'n', 11]]);
    assert.ok(h.lane.some((e) => e.type === 'patch' && e.path === '/dir/a'), 'item hold under the real token remains');
    // Budget freed: cap of 2 with one live item hold — a fresh slot must fit.
    h.watcher.watch('u1', ['/elsewhere'], { token: 'tab' });
  });

  it('overlapping same-token requests hold independent provisionals — one completing keeps the other covered (r3-F3)', async () => {
    const h = await observed();
    let scan = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const gateFirst = new Promise<void>((r) => { releaseFirst = r; });
    const gateSecond = new Promise<void>((r) => { releaseSecond = r; });
    let firstParked!: () => void;
    let secondParked!: () => void;
    const parked = Promise.all([
      new Promise<void>((r) => { firstParked = r; }),
      new Promise<void>((r) => { secondParked = r; }),
    ]);
    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      getChildren: async (p: string, o?: AclChildrenOpts, c?: unknown) => {
        const page = await h.tree.getChildren(p, o, c);
        if (++scan === 1) { firstParked(); await gateFirst; }
        else { secondParked(); await gateSecond; }
        return page;
      },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    const pa = client.req.ls('/dir', { watch: true, token: 'tab' });
    const pb = client.req.ls('/dir', { watch: true, token: 'tab' });
    await parked; // both mid-scan — both provisionals held on /dir

    releaseFirst();
    await Promise.race([pa, pb]); // one request completed and released ITS provisional

    await h.tree.set(createNode('/dir/late', 'item', { n: 9 }));
    assert.ok(h.lane.some((e) => e.type === 'set' && e.path === '/dir/late'),
      "the in-flight request's provisional still covers the window");

    releaseSecond();
    await Promise.all([pa, pb]);
    h.lane.length = 0;
    await h.tree.set(createNode('/dir/post', 'item', { n: 10 }));
    assert.ok(!h.lane.some((e) => e.type === 'set' && e.path === '/dir/post'),
      'all provisionals released — converged holds are item-only');
  });

  it('ls{watch} without parent-S: no provisional — the window stays residual (§3.5), items still watched', async () => {
    const h = await observed();
    const gated = Object.assign(Object.create(h.tree) as typeof h.tree, {
      getPerm: async (p: string) => (p === '/dir' ? R : R | S), // S on items only
    });
    const serveTree = Object.assign(Object.create(gated) as typeof gated, {
      getChildren: async (p: string, o?: AclChildrenOpts, c?: unknown) => {
        const page = await h.tree.getChildren(p, o, c);
        await h.tree.set(createNode('/dir/mid', 'item', { n: 2 }));
        return page;
      },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    await client.req.ls('/dir', { watch: true, token: 'tab' });

    assert.deepEqual(h.journal, ['watch:/dir/a'], 'no provisional hold without parent-S; item watches post-read');
    assert.ok(!h.lane.some((e) => e.type === 'set' && e.path === '/dir/mid'),
      'mid-scan create lost — the documented residual for this sub-case');
    await h.tree.patch('/dir/a', [['r', 'n', 5]]);
    assert.ok(h.lane.some((e) => e.type === 'patch' && e.path === '/dir/a'), 'item hold live');
  });

  it('read failure after registration: lease undone — pre-existing hold and replaced query plan restored (invariant 15)', async () => {
    const h = await observed();
    // Pre-existing under the SAME token: prefix hold + query plan A on /dir.
    const planA: ResolvedReadPlan = { plan: { source: '/dir', callerWhere: { kind: 'a' } }, mountDeps: new Set(['/dir']) };
    h.watcher.watch('u1', ['/dir'], { children: true, query: { plan: planA.plan, mountDeps: planA.mountDeps }, token: 'tab' });

    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      planChildren: async (p: string, o?: PlanChildrenOpts): Promise<ResolvedReadPlan> => ({
        plan: { source: p, ...(o?.query ? { callerWhere: o.query } : {}) },
        mountDeps: new Set([p]),
      }),
      getChildren: async (): Promise<never> => { throw new OpError('NOT_FOUND', 'scan failed'); },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    await assert.rejects(
      client.req.ls('/dir', { watchList: true, query: { kind: 'b' }, token: 'tab' }),
      isCode('NOT_FOUND'),
    );

    // The pre-existing prefix hold survives the undo…
    await h.tree.set(createNode('/dir/n1', 'item', { kind: 'a' }));
    const ev = h.lane.find((e) => e.type === 'set' && e.path === '/dir/n1');
    assert.ok(ev, 'pre-existing hold under the same token survives compensation');
    // …and membership evaluates the RESTORED plan A, not the undone plan B.
    assert.ok(ev.invalidateVps?.includes('/dir'), 'replaced query plan restored by the undo');
  });

  it('undo failure is loud and never masks the read error', async () => {
    const h = await observed();
    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      getChildren: async (): Promise<never> => { throw new OpError('NOT_FOUND', 'scan failed'); },
    });
    const hooks: ServeHooks = {
      ...h.hooks,
      watchList: () => ({ undo: () => { throw new Error('undo boom'); } }),
    };
    const { client } = pair(() => ({ tree: serveTree, hooks }));

    const originalError = console.error;
    let logged = false;
    console.error = () => { logged = true; };
    try {
      await assert.rejects(client.req.ls('/dir', { watchList: true, token: 'tab' }), isCode('NOT_FOUND'));
    } finally {
      console.error = originalError;
    }
    assert.ok(logged, 'undo failure logged loudly');
  });

  it('resolve{watch}: target watch registered before the re-get; response carries the post-registration image (§3.2.7)', async () => {
    const h = await observed();
    await h.memory.set(createNode('/target', 'item', { v: 1 }));
    await h.memory.set({ $path: '/link', $type: 'ref', $ref: '/target' });
    let targetGets = 0;
    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      get: async (p: string, c?: unknown) => {
        const n = await h.tree.get(p, c);
        if (p === '/target') {
          h.journal.push(`get:/target#${++targetGets}`);
          if (targetGets === 2 && n) return { ...n, v: 2 }; // image AFTER registration
        }
        return n;
      },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    const out = await client.req.resolve('/link', true, 'tab') as { $path: string; v?: number }[];

    assert.deepEqual(out.map((n) => n.$path), ['/link', '/target']);
    assert.equal(out[1].v, 2, 'response carries the re-get image, not the pre-registration one');
    const wi = h.journal.indexOf('watch:/target');
    const gi = h.journal.indexOf('get:/target#2');
    assert.ok(wi !== -1 && gi !== -1 && wi < gi, 'target watch stood before the re-get');
  });

  it('resolve{watch} on an absent path returns [] and keeps no watch', async () => {
    const h = await observed();
    const { client } = pair(() => ({ tree: h.base, hooks: h.hooks }));

    assert.deepEqual(await client.req.resolve('/dir/ghost', true, 'tab'), []);

    await h.tree.set(createNode('/dir/ghost', 'item', { n: 1 }));
    assert.ok(!h.lane.some((e) => e.type === 'set' && e.path === '/dir/ghost'), 'no watch left behind');
  });

  it('get{watch}: registration precedes the read — a write mid-read reaches the lane (W-get)', async () => {
    const h = await observed();
    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      get: async (p: string, c?: unknown) => {
        const n = await h.tree.get(p, c);
        await h.tree.patch('/dir/a', [['r', 'n', 7]]); // lands mid-read
        return n;
      },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    await client.req.get('/dir/a', true, 'tab');

    assert.deepEqual(h.journal, ['watch:/dir/a'], 'register-first call order');
    assert.ok(h.lane.some((e) => e.type === 'patch' && e.path === '/dir/a'), 'mid-read write delivered');
  });

  it('get{watch} read failure: created hold undone, pre-existing hold under the same token survives', async () => {
    const h = await observed();
    h.watcher.watch('u1', ['/dir/a'], { token: 'tab' }); // pre-existing
    const serveTree = Object.assign(Object.create(h.base) as typeof h.base, {
      get: async (): Promise<never> => { throw new OpError('NOT_FOUND', 'read failed'); },
    });
    const { client } = pair(() => ({ tree: serveTree, hooks: h.hooks }));

    await assert.rejects(client.req.get('/dir/b', true, 'tab'), isCode('NOT_FOUND')); // fresh hold → undone
    await assert.rejects(client.req.get('/dir/a', true, 'tab'), isCode('NOT_FOUND')); // pre-existing → kept

    await h.tree.set(createNode('/dir/b', 'item', { n: 1 }));
    assert.ok(!h.lane.some((e) => e.type === 'set' && e.path === '/dir/b'), 'created hold gone');
    await h.tree.patch('/dir/a', [['r', 'n', 9]]);
    assert.ok(h.lane.some((e) => e.type === 'patch' && e.path === '/dir/a'), 'pre-existing hold survives');
  });

  it('get{watch} on an absent path keeps no watch (pre-slice-4 contract pinned)', async () => {
    const h = await observed();
    const { client } = pair(() => ({ tree: h.base, hooks: h.hooks }));

    assert.equal(await client.req.get('/dir/ghost', true, 'tab'), undefined);

    await h.tree.set(createNode('/dir/ghost', 'item', { n: 1 }));
    assert.ok(!h.lane.some((e) => e.type === 'set' && e.path === '/dir/ghost'), 'no watch left behind');
  });
});

// ── ns6p.4 F7: unbound-token TTL arms at the request boundary (inv.25) ──

describe('request-boundary TTL arm (ns6p.4 F7)', () => {
  function armHarness() {
    const armed: string[] = [];
    const tree = createMemoryTree();
    const base = Object.assign(Object.create(tree) as typeof tree, {
      getPerm: async () => R | S,
    });
    const hooks: ServeHooks = {
      watch: () => {},
      unwatch: () => {},
      armUnboundTtl: (token) => armed.push(token),
    };
    return { armed, tree, base, hooks };
  }

  it('a tokened request arms AFTER completion; tokenless never arms', async () => {
    const h = armHarness();
    await h.tree.set(createNode('/doc', 'dir', {}));
    const { client } = pair(() => ({ tree: h.base, hooks: h.hooks }));

    await client.req.get('/doc', true, 'tab1');
    assert.deepEqual(h.armed, ['tab1'], 'arm called once, with the frame token');

    await client.req.get('/doc', true);
    assert.deepEqual(h.armed, ['tab1'], 'tokenless request never arms');
  });

  it('arms even when the request fails — a lease undone mid-request must still not outlive its token silently', async () => {
    const h = armHarness();
    const failing = Object.assign(Object.create(h.base) as typeof h.base, {
      get: async (): Promise<never> => { throw new OpError('NOT_FOUND', 'read failed'); },
    });
    const { client } = pair(() => ({ tree: failing, hooks: h.hooks }));

    await assert.rejects(client.req.get('/doc', true, 'tab2'), isCode('NOT_FOUND'));
    assert.deepEqual(h.armed, ['tab2'], 'failure path reaches the arm too');
  });

  it('brackets the request: begin before the read, arm at the boundary — one pair per tokened request (r2-F3, inv.25)', async () => {
    const journal: string[] = [];
    const tree = createMemoryTree();
    await tree.set(createNode('/doc', 'dir', {}));
    const base = Object.assign(Object.create(tree) as typeof tree, {
      getPerm: async () => R | S,
      get: async (p: string, c?: unknown) => { journal.push('read'); return tree.get(p, c); },
    });
    const hooks: ServeHooks = {
      watch: () => {},
      unwatch: () => {},
      beginTokenRequest: (token) => journal.push(`begin:${token}`),
      armUnboundTtl: (token) => journal.push(`arm:${token}`),
    };
    const { client } = pair(() => ({ tree: base, hooks }));

    await client.req.get('/doc', true, 'tab1');
    assert.deepEqual(journal, ['begin:tab1', 'read', 'arm:tab1'], 'exactly one begin/arm pair, bracketing the read');

    journal.length = 0;
    await client.req.get('/doc', true);
    assert.deepEqual(journal, ['read'], 'tokenless request opens no bracket');
  });
});
