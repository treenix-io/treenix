// move() — atomic relocation with tombstones (core-gk8.10 stage 2).
// Runs over the full storage policy (memory backing) so $id echo/mint
// semantics are the real ones: tombstones echo the moved node's id,
// destination members carry it.

import { createNode, isMoved } from '#core';
import { KernelError } from '#errors';
import { createMemoryTree, resolveRef, type Tree } from '#tree';
import { withStoragePolicy } from '#tree/policy';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mutationLock, withCommitEnvelope } from './commit';
import { move } from './move';

const isCode = (code: string) => (e: unknown) => e instanceof KernelError && e.code === code;

function pipeline(): Tree {
  return withStoragePolicy(createMemoryTree()).tree;
}

describe('move (core-gk8.10 stage 2)', () => {
  it('moves a leaf: identity travels, tombstone stays behind with the same id', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'doc', { n: 1 }));
    const before = await tree.get('/a');
    assert.ok(before?.$id);

    const res = await move(tree, '/a', '/b');
    assert.equal(res.moved, 1);

    const moved = await tree.get('/b');
    assert.equal(moved?.$id, before.$id);
    assert.equal(moved?.n, 1);

    const stone = await tree.get('/a');
    assert.ok(stone && isMoved(stone));
    assert.equal(stone.$ref, '/b');
    assert.equal(stone.$id, before.$id, 'tombstone echoes the moved id');
  });

  it('moves a subtree: every node relocated, one tombstone per node', async () => {
    const tree = pipeline();
    await tree.set(createNode('/x', 'dir', {}));
    await tree.set(createNode('/x/a', 'doc', { n: 1 }));
    await tree.set(createNode('/x/a/deep', 'doc', { n: 2 }));
    const ids = new Map<string, unknown>();
    for (const p of ['/x', '/x/a', '/x/a/deep']) ids.set(p, (await tree.get(p))?.$id);

    const res = await move(tree, '/x', '/y');
    assert.equal(res.moved, 3);

    assert.equal((await tree.get('/y'))?.$id, ids.get('/x'));
    assert.equal((await tree.get('/y/a'))?.$id, ids.get('/x/a'));
    assert.equal((await tree.get('/y/a/deep'))?.$id, ids.get('/x/a/deep'));
    for (const p of ['/x', '/x/a', '/x/a/deep']) {
      const stone = await tree.get(p);
      assert.ok(stone && isMoved(stone), `tombstone at ${p}`);
    }
    assert.equal((await tree.get('/x/a'))?.$ref, '/y/a');
  });

  it('a path ref to the moved node resolves through the tombstone and repairs', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'doc', { n: 1 }));
    await tree.set({ $path: '/r', $type: 'ref', $ref: '/a' });
    await move(tree, '/a', '/b');

    const stored = await tree.get('/r');
    const target = await resolveRef(tree, stored!);
    assert.equal(target.$path, '/b');
    assert.equal(target.n, 1);

    const repaired = await tree.get('/r');
    assert.equal(repaired?.$ref, '/b');
    assert.equal(repaired?.$refId, target.$id, 'adopted the identity');
  });

  it('chained moves resolve end-to-end', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'doc', {}));
    await tree.set({ $path: '/r', $type: 'ref', $ref: '/a' });
    await move(tree, '/a', '/b');
    await move(tree, '/b', '/c');

    const target = await resolveRef(tree, (await tree.get('/r'))!);
    assert.equal(target.$path, '/c');
  });

  it('move back home replaces the own tombstone', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'doc', { n: 1 }));
    const id = (await tree.get('/a'))?.$id;
    assert.ok(id);
    await move(tree, '/a', '/b');
    await move(tree, '/b', '/a');

    const home = await tree.get('/a');
    assert.equal(home?.$id, id);
    assert.equal(home?.n, 1);
    assert.ok(!isMoved(home!));

    // The stale chain at /b now terminates at the real node.
    const stone = await tree.get('/b');
    assert.ok(stone && isMoved(stone));
    const target = await resolveRef(tree, { $ref: '/b', $refId: id });
    assert.equal(target.$path, '/a');
  });

  it('occupied destination denies the whole move', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'doc', { n: 1 }));
    await tree.set(createNode('/b', 'doc', { n: 2 }));

    await assert.rejects(() => move(tree, '/a', '/b'), isCode('CONFLICT'));
    assert.equal((await tree.get('/a'))?.n, 1, 'source intact');
    assert.equal((await tree.get('/b'))?.n, 2, 'destination intact');
  });

  it('occupied destination DESCENDANT denies the move', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'dir', {}));
    await tree.set(createNode('/b/taken', 'doc', {}));

    await assert.rejects(() => move(tree, '/a', '/b'), isCode('CONFLICT'));
  });

  it('foreign tombstone at the destination stays protected', async () => {
    const tree = pipeline();
    await tree.set(createNode('/other', 'doc', {}));
    await move(tree, '/other', '/elsewhere');
    await move(tree, '/elsewhere', '/b');
    // /elsewhere now holds a tombstone of ANOTHER node's chain.
    await tree.set(createNode('/a', 'doc', {}));
    await assert.rejects(() => move(tree, '/a', '/elsewhere'), isCode('CONFLICT'));
  });

  it('rejects moving the root, into itself, and onto itself', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'dir', {}));
    await assert.rejects(() => move(tree, '/', '/b'), isCode('INVALID'));
    await assert.rejects(() => move(tree, '/a', '/a'), isCode('INVALID'));
    await assert.rejects(() => move(tree, '/a', '/a/sub'), isCode('INVALID'));
  });

  it('rejects a missing source and a tombstone source', async () => {
    const tree = pipeline();
    await assert.rejects(() => move(tree, '/gone', '/b'), isCode('NOT_FOUND'));

    await tree.set(createNode('/a', 'doc', {}));
    await move(tree, '/a', '/b');
    await assert.rejects(() => move(tree, '/a', '/c'), isCode('INVALID'));
  });

  it('carries $acl and $owner onto the tombstone', async () => {
    const tree = pipeline();
    await tree.set({ ...createNode('/a', 'doc', {}), $acl: [{ g: 'team', p: 3 }], $owner: 'u1' });
    await move(tree, '/a', '/b');

    const stone = await tree.get('/a');
    assert.deepEqual(stone?.$acl, [{ g: 'team', p: 3 }]);
    assert.equal(stone?.$owner, 'u1');
  });

  it('concurrent modification between scan and commit denies atomically', async () => {
    const tree = pipeline();
    await tree.set(createNode('/x', 'dir', {}));
    await tree.set(createNode('/x/a', 'doc', { n: 1 }));

    // Serve a stale $rev for the root snapshot (move reads it via get; the
    // descendants come from scanChildren) — the batch's OCC must deny ALL.
    const stale: Tree = {
      ...tree,
      get: async (p, c) => {
        const n = await tree.get(p, c);
        if (n && p === '/x') n.$rev = (n.$rev ?? 0) + 41;
        return n;
      },
    };
    await assert.rejects(() => move(stale, '/x', '/y'), isCode('CONFLICT'));
    assert.equal(await tree.get('/y'), undefined, 'nothing committed');
    assert.ok(!isMoved((await tree.get('/x'))!), 'no tombstone written');
  });

  it('a carried foreign $id cannot replace a tombstone without a trusted relocation (core-anz4.2)', async () => {
    const tree = pipeline();
    await tree.set(createNode('/victim', 'doc', {}));
    const victimId = (await tree.get('/victim'))?.$id;
    assert.ok(victimId);
    await tree.set(createNode('/a', 'doc', {}));
    await move(tree, '/a', '/b');

    // Impersonation: a plain write replacing /a's tombstone while claiming the
    // victim's identity — must fail loud, not store a duplicate ULID.
    await assert.rejects(
      () => tree.set({ ...createNode('/a', 'doc', {}), $id: victimId }),
      isCode('INVALID'),
    );
  });

  it('a fresh write onto a tombstoned path mints a NEW identity (no id theft)', async () => {
    const tree = pipeline();
    await tree.set(createNode('/a', 'doc', {}));
    const id = (await tree.get('/a'))?.$id;
    assert.ok(id);
    await move(tree, '/a', '/b');

    await tree.set(createNode('/a', 'doc', { fresh: true }));
    const impostor = await tree.get('/a');
    assert.ok(impostor?.$id);
    assert.notEqual(impostor.$id, id, 'moved identity is not echoed into an unrelated node');

    // An id-carrying ref to the moved node now fails loud instead of
    // resolving to the impostor.
    await assert.rejects(
      () => resolveRef(tree, { $ref: '/a', $refId: id }),
      isCode('NOT_FOUND'),
    );
  });
});

// ── scan→commit TOCTOU (core-anz4.5) ──
// move holds subtree spans on source+destination in the shared mutationLock;
// a concurrent in-process write (which always flows through the commit
// envelope in the real pipeline) parks until the span ends instead of landing
// inside the window. detach() models an independent request chain — without
// it the injected write would inherit move's held set via ALS and run inline.

describe('move: concurrent writes during scan→commit (core-anz4.5)', () => {
  function harness() {
    const policy = withStoragePolicy(createMemoryTree()).tree;
    const log: string[] = [];
    const logged: Tree = {
      ...policy,
      async set(node, ctx) { log.push(`set:${node.$path}`); return policy.set(node, ctx); },
      async patchMany(ancestor, entries, ctx) { log.push('move-commit'); return policy.patchMany!(ancestor, entries, ctx); },
    };
    const envelope = withCommitEnvelope(logged);
    return { policy, log, logged, envelope };
  }

  async function moveWithInjectedWrite(inject: (h: ReturnType<typeof harness>) => Promise<unknown>) {
    const h = harness();
    await h.policy.set(createNode('/x', 'dir', {}));
    await h.policy.set(createNode('/x/a', 'doc', { n: 1 }));

    let writer: Promise<unknown> | undefined;
    const interposed: Tree = {
      ...h.logged,
      scanChildren: async function* (parent, opts, ctx) {
        for await (const e of h.policy.scanChildren!(parent, opts, ctx)) {
          if (parent === '/x' && !writer) writer = mutationLock.detach(() => inject(h));
          yield e;
        }
      },
    };

    const res = await move(interposed, '/x', '/y');
    assert.ok(writer, 'the concurrent write was injected during the scan');
    await writer;
    return { ...h, res };
  }

  it('a create under the SOURCE waits for the whole span — no orphan under the tombstone', async () => {
    const { res, log, policy } = await moveWithInjectedWrite(
      ({ envelope }) => envelope.set(createNode('/x/late', 'doc', {})),
    );

    assert.equal(res.moved, 2, 'exactly the scanned members moved');
    assert.ok(log.indexOf('set:/x/late') > log.indexOf('move-commit'), 'the write waited for the move span');
    assert.equal(await policy.get('/y/late'), undefined, 'nothing slipped into the moved set');
    assert.ok(await policy.get('/x/late'), 'the write landed after the span as an ordinary post-move write');
  });

  it('a create under the DESTINATION waits instead of being adopted mid-move', async () => {
    const { res, log, policy } = await moveWithInjectedWrite(
      ({ envelope }) => envelope.set(createNode('/y/stray', 'doc', {})),
    );

    assert.equal(res.moved, 2);
    assert.ok(log.indexOf('set:/y/stray') > log.indexOf('move-commit'), 'the write waited for the move span');
    assert.ok(await policy.get('/y/stray'), 'landed after the move as an ordinary child of the new subtree');
  });
});
