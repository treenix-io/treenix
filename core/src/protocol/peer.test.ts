// TWP peer over loopback — protocol-core contract tests (docs/research/twp-spec.md §5).

import { createNode, R, S } from '#core';
import { OpError } from '#errors';
import { createMemoryTree } from '#tree';
import { relocateCtx, withStoragePolicy } from '#tree/policy';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoopback } from './loopback';
import { createPeer, type PeerServe, type ServeFactory } from './peer';

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
      tree,
      hooks: {
        watch: () => {},
        unwatch: () => {},
        watchList: (path) => pages.push(path),
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
        watch: (paths) => watched.push(paths),
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
        watch: (paths, o) => calls.push({ op: 'watch', paths, children: o?.children }),
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
});
