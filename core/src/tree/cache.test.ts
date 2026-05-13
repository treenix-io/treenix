import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withCache } from './cache';
import { createMemoryTree } from './index';

function makeNode(path: string, extra?: Record<string, unknown>) {
  return { $path: path, $type: 'test', ...extra };
}

describe('withCache — reads', () => {
  it('miss: delegates to underlying tree', async () => {
    const mem = createMemoryTree();
    await mem.set(makeNode('/a'));
    const cached = withCache(mem);
    const node = await cached.get('/a');
    assert.ok(node);
    assert.equal(node.$path, '/a');
  });

  it('hit: second get does not call underlying tree', async () => {
    let calls = 0;
    const mem = createMemoryTree();
    await mem.set(makeNode('/a'));

    const spied: typeof mem = {
      ...mem,
      async get(path, ctx) { calls++; return mem.get(path, ctx); },
      async getChildren(p, o, c) { return mem.getChildren(p, o, c); },
      async set(n, c) { return mem.set(n, c); },
      async remove(p, c) { return mem.remove(p, c); },
    };

    const cached = withCache(spied);
    await cached.get('/a');  // miss — calls underlying
    await cached.get('/a');  // hit — should NOT call underlying
    assert.equal(calls, 1);
  });

  it('get on missing path returns undefined without caching null', async () => {
    const mem = createMemoryTree();
    const cached = withCache(mem);
    const result = await cached.get('/nonexistent');
    assert.equal(result, undefined);
    // After the node is added, it should be fetchable
    await mem.set(makeNode('/nonexistent'));
    const fresh = await cached.get('/nonexistent');
    assert.ok(fresh);
  });

  // Regression: prior deepFreeze on cached nodes broke upper layers that
  // attach metadata via Object.defineProperty (e.g. @treenx/react stamps
  // $key/$node symbols on returned nodes). Extensibility is part of the
  // cache's contract — consumers must be able to annotate results.
  it('returned nodes are extensible', async () => {
    const mem = createMemoryTree();
    await mem.set(makeNode('/a', { comp: { $type: 'c', v: 1 } }));
    const cached = withCache(mem);

    const node = await cached.get('/a');
    assert.ok(node);
    assert.equal(Object.isExtensible(node), true, 'node must be extensible');
    assert.equal(Object.isExtensible((node as any).comp), true, 'nested component must be extensible');

    const { items } = await cached.getChildren('/');
    for (const item of items) {
      assert.equal(Object.isExtensible(item), true, `${item.$path} must be extensible`);
    }
  });
});

describe('withCache — writes populate', () => {
  it('set populates cache — next get returns fresh without underlying call', async () => {
    let gets = 0;
    const mem = createMemoryTree();

    const spied: typeof mem = {
      ...mem,
      async get(path, ctx) { gets++; return mem.get(path, ctx); },
      async getChildren(p, o, c) { return mem.getChildren(p, o, c); },
      async set(n, c) { return mem.set(n, c); },
      async remove(p, c) { return mem.remove(p, c); },
    };

    const cached = withCache(spied);
    await cached.set(makeNode('/a', { v: 1 })); // write-populate: 1 get for re-read
    gets = 0;

    const node = await cached.get('/a'); // should hit cache
    assert.equal(gets, 0);
    assert.equal((node as any).v, 1);
  });

  it('set captures fresh $rev in cache', async () => {
    const mem = createMemoryTree();
    const cached = withCache(mem);

    await cached.set(makeNode('/a', { v: 1 }));
    const node = await cached.get('/a');
    assert.equal(node?.$rev, 1, 'cache should have $rev bumped by tree');
  });

  it('set then bypass update then set — cache reflects last write', async () => {
    const mem = createMemoryTree();
    const cached = withCache(mem);

    await cached.set(makeNode('/a', { v: 1 }));
    await mem.set(makeNode('/a', { v: 2 }));       // bypass cache
    await cached.set(makeNode('/a', { v: 3 }));     // write-populate

    const node = await cached.get('/a');
    assert.equal((node as any).v, 3);
  });

  it('remove invalidates cache entry', async () => {
    const mem = createMemoryTree();
    await mem.set(makeNode('/a'));
    const cached = withCache(mem);

    await cached.get('/a');      // populate cache
    await cached.remove('/a');   // invalidate
    const node = await cached.get('/a');
    assert.equal(node, undefined);
  });
});

describe('withCache — patch via set', () => {
  it('patch warms cache — next get returns patched data without underlying call', async () => {
    let gets = 0;
    const mem = createMemoryTree();
    await mem.set(makeNode('/a', { count: 5 }));

    const spied: typeof mem = {
      ...mem,
      async get(path, ctx) { gets++; return mem.get(path, ctx); },
      async getChildren(p, o, c) { return mem.getChildren(p, o, c); },
      async set(n, c) { return mem.set(n, c); },
      async remove(p, c) { return mem.remove(p, c); },
    };

    const cached = withCache(spied);
    await cached.patch('/a', [['r', 'count', 10]]);
    gets = 0; // reset after patch

    const node = await cached.get('/a'); // should hit cache
    assert.equal(gets, 0, 'no underlying get after patch');
    assert.equal((node as any).count, 10);
  });

  it('patch goes through set — $rev is bumped', async () => {
    const mem = createMemoryTree();
    await mem.set(makeNode('/a', { v: 1 }));
    const cached = withCache(mem);

    await cached.patch('/a', [['r', 'v', 2]]);
    const node = await cached.get('/a');
    assert.equal(node?.$rev, 2, 'patch via set should bump $rev');
    assert.equal((node as any).v, 2);
  });
});

describe('withCache — inflight dedup', () => {
  it('concurrent gets produce single underlying call', async () => {
    let calls = 0;
    const mem = createMemoryTree();
    await mem.set(makeNode('/a', { v: 42 }));

    const spied: typeof mem = {
      ...mem,
      async get(path, ctx) {
        calls++;
        // Simulate async delay
        await new Promise(r => setImmediate(r));
        return mem.get(path, ctx);
      },
      async getChildren(p, o, c) { return mem.getChildren(p, o, c); },
      async set(n, c) { return mem.set(n, c); },
      async remove(p, c) { return mem.remove(p, c); },
    };

    const cached = withCache(spied);

    // Fire 10 concurrent gets
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cached.get('/a')),
    );

    assert.equal(calls, 1, 'only one underlying get call');
    for (const r of results) {
      assert.equal((r as any).v, 42);
    }
  });

  it('after inflight settles, next call retries', async () => {
    let calls = 0;
    const mem = createMemoryTree();
    await mem.set(makeNode('/a'));

    const spied: typeof mem = {
      ...mem,
      async get(path, ctx) { calls++; return mem.get(path, ctx); },
      async getChildren(p, o, c) { return mem.getChildren(p, o, c); },
      async set(n, c) { return mem.set(n, c); },
      async remove(p, c) { return mem.remove(p, c); },
    };

    const cached = withCache(spied);
    await cached.get('/a');          // miss → call 1, populates cache
    await cached.remove('/a');       // invalidates
    await mem.set(makeNode('/a'));    // restore in underlying
    await cached.get('/a');          // miss again → call 2
    assert.equal(calls, 2);
  });
});

describe('withCache — getChildren populates cache', () => {
  it('nodes fetched via getChildren are cached for subsequent get', async () => {
    let gets = 0;
    const mem = createMemoryTree();
    await mem.set(makeNode('/parent'));
    await mem.set(makeNode('/parent/child'));

    const spied: typeof mem = {
      ...mem,
      async get(path, ctx) { gets++; return mem.get(path, ctx); },
      async getChildren(p, o, c) { return mem.getChildren(p, o, c); },
      async set(n, c) { return mem.set(n, c); },
      async remove(p, c) { return mem.remove(p, c); },
    };

    const cached = withCache(spied);
    await cached.getChildren('/parent');   // fetches children, populates cache
    gets = 0;                              // reset counter

    await cached.get('/parent/child');     // should hit cache, not call underlying
    assert.equal(gets, 0);
  });
});

describe('withCache — bounded', () => {
  it('evicts oldest entries when capacity exceeded', async () => {
    let gets = 0;
    const mem = createMemoryTree();
    for (let i = 0; i < 5; i++) await mem.set(makeNode(`/n${i}`));

    const spied: typeof mem = {
      ...mem,
      async get(path, ctx) { gets++; return mem.get(path, ctx); },
      async getChildren(p, o, c) { return mem.getChildren(p, o, c); },
      async set(n, c) { return mem.set(n, c); },
      async remove(p, c) { return mem.remove(p, c); },
    };

    const cached = withCache(spied, 3);
    for (let i = 0; i < 5; i++) await cached.get(`/n${i}`); // fills + evicts /n0,/n1
    gets = 0;

    await cached.get('/n4');                                // hit
    await cached.get('/n0');                                // evicted → re-fetch
    assert.equal(gets, 1);
  });
});

describe('withCache — tree structure', () => {
  it('caches deep paths independently', async () => {
    const mem = createMemoryTree();
    await mem.set(makeNode('/a/b/c'));
    await mem.set(makeNode('/a/b/d'));
    const cached = withCache(mem);

    await cached.get('/a/b/c');
    await cached.get('/a/b/d');

    // Verify both are in cache by checking remove invalidates correctly
    await cached.remove('/a/b/c');
    const c = await cached.get('/a/b/c');
    const d = await cached.get('/a/b/d'); // /d is still cached
    assert.equal(c, undefined);
    assert.ok(d);
  });

  it('sibling paths do not interfere', async () => {
    const mem = createMemoryTree();
    await mem.set(makeNode('/x/a', { tag: 'a' }));
    await mem.set(makeNode('/x/b', { tag: 'b' }));
    const cached = withCache(mem);

    const a = await cached.get('/x/a');
    const b = await cached.get('/x/b');
    assert.equal((a as any).tag, 'a');
    assert.equal((b as any).tag, 'b');
  });
});
