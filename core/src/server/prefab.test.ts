import { createNode, type NodeData } from '#core';
import { clearPrefabs, getModPrefabs, getPrefab, getRegisteredMods, getSeedPrefabs, registerPrefab } from '#mod/prefab';
import '#mods/treenix/prefab-type';
import { loadSchemasFromDir } from '#schema/load';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

loadSchemasFromDir(join(dirname(fileURLToPath(import.meta.url)), '../mods/treenix/schemas'));
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { executeAction } from './actions';
import { createModsStore } from './mods-mount';
import { deployByKey, deployPrefab, deploySeedPrefabs } from './prefab';

describe('Prefab registry', () => {
  beforeEach(() => clearPrefabs());
  afterEach(() => clearPrefabs());

  it('registerPrefab stores and getPrefab retrieves', () => {
    registerPrefab('orders', 'infra', [
      { $path: 'data', $type: 'mount-point' } as NodeData,
    ]);
    const entry = getPrefab('orders', 'infra');
    assert.ok(entry);
    assert.equal(entry.nodes.length, 1);
    assert.equal(entry.nodes[0].$type, 'mount-point');
  });

  it('sealed: duplicate registerPrefab is no-op', () => {
    registerPrefab('a', 'b', [{ $path: 'x', $type: 'dir' } as NodeData]);
    registerPrefab('a', 'b', [{ $path: 'y', $type: 'other' } as NodeData]);
    assert.equal(getPrefab('a', 'b')!.nodes[0].$path, 'x');
  });

  it('getModPrefabs returns all prefabs for a mod', () => {
    registerPrefab('orders', 'infra', [{ $path: '.', $type: 'dir' } as NodeData]);
    registerPrefab('orders', 'demo', [{ $path: 'x', $type: 'dir' } as NodeData]);
    registerPrefab('sim', 'world', [{ $path: '.', $type: 'dir' } as NodeData]);

    const ordersPrefabs = getModPrefabs('orders');
    assert.equal(ordersPrefabs.length, 2);
    assert.deepEqual(ordersPrefabs.map(([n]) => n).sort(), ['demo', 'infra']);
  });

  it('getRegisteredMods returns unique mod names', () => {
    registerPrefab('orders', 'infra', [{ $path: '.', $type: 'dir' } as NodeData]);
    registerPrefab('orders', 'demo', [{ $path: 'x', $type: 'dir' } as NodeData]);
    registerPrefab('sim', 'world', [{ $path: '.', $type: 'dir' } as NodeData]);

    const mods = getRegisteredMods();
    assert.deepEqual(mods.sort(), ['orders', 'sim']);
  });

  it('getPrefab returns undefined for missing', () => {
    assert.equal(getPrefab('nope', 'nope'), undefined);
  });
});

describe('Mods mount', () => {
  let backing: Tree;

  beforeEach(() => {
    clearPrefabs();
    backing = createMemoryTree();
  });
  afterEach(() => clearPrefabs());

  it('get /sys/mods returns dir', async () => {
    const ms = createModsStore(backing);
    const node = await ms.get('/sys/mods');
    assert.equal(node?.$type, 't.dir');
  });

  it('get /sys/mods/{mod} returns t.mod for registered mod', async () => {
    registerPrefab('orders', 'infra', [{ $path: 'data', $type: 'dir' } as NodeData]);
    const ms = createModsStore(backing);
    const node = await ms.get('/sys/mods/orders');
    assert.equal(node?.$type, 't.mod');
    assert.equal((node as any).name, 'orders');
    assert.deepEqual((node as any).prefabs, ['infra']);
  });

  it('get returns undefined for unregistered mod', async () => {
    const ms = createModsStore(backing);
    const node = await ms.get('/sys/mods/nope');
    assert.equal(node, undefined);
  });

  it('getChildren /sys/mods lists all mods', async () => {
    registerPrefab('orders', 'infra', [{ $path: '.', $type: 'dir' } as NodeData]);
    registerPrefab('sim', 'world', [{ $path: '.', $type: 'dir' } as NodeData]);
    const ms = createModsStore(backing);
    const { items } = await ms.getChildren('/sys/mods');
    assert.equal(items.length, 2);
    const paths = items.map(n => n.$path).sort();
    assert.deepEqual(paths, ['/sys/mods/orders', '/sys/mods/sim']);
  });

  it('getChildren /sys/mods/{mod} lists prefabs dir', async () => {
    registerPrefab('orders', 'infra', [{ $path: 'data', $type: 'dir' } as NodeData]);
    const ms = createModsStore(backing);
    const { items } = await ms.getChildren('/sys/mods/orders');
    assert.ok(items.some(n => n.$path === '/sys/mods/orders/prefabs'));
  });

  it('getChildren /sys/mods/{mod}/prefabs lists prefab names', async () => {
    registerPrefab('orders', 'infra', [{ $path: 'data', $type: 'dir' } as NodeData]);
    registerPrefab('orders', 'demo', [{ $path: 'x', $type: 'dir' } as NodeData]);
    const ms = createModsStore(backing);
    const { items } = await ms.getChildren('/sys/mods/orders/prefabs');
    assert.equal(items.length, 2);
    const paths = items.map(n => n.$path).sort();
    assert.deepEqual(paths, ['/sys/mods/orders/prefabs/demo', '/sys/mods/orders/prefabs/infra']);
  });

  it('getChildren lists prefab nodes (direct children only)', async () => {
    registerPrefab('orders', 'infra', [
      { $path: '.', $type: 'dir' } as NodeData,
      { $path: 'data', $type: 'mount-point' } as NodeData,
      { $path: 'kitchen', $type: 'mount-point' } as NodeData,
      { $path: 'nested/deep', $type: 'dir' } as NodeData, // skipped — not direct
      { $path: '/sys/autostart/x', $type: 'ref' } as NodeData, // skipped — absolute
    ]);
    const ms = createModsStore(backing);
    const { items } = await ms.getChildren('/sys/mods/orders/prefabs/infra');
    assert.equal(items.length, 2); // data + kitchen
    assert.deepEqual(items.map(n => n.$path).sort(), [
      '/sys/mods/orders/prefabs/infra/data',
      '/sys/mods/orders/prefabs/infra/kitchen',
    ]);
  });

  it('set throws (read-only)', async () => {
    const ms = createModsStore(backing);
    await assert.rejects(
      () => ms.set(createNode('/sys/mods/x', 'dir')),
      (e: Error) => e.message.includes('read-only'),
    );
  });

  it('remove throws (read-only)', async () => {
    const ms = createModsStore(backing);
    await assert.rejects(
      () => ms.remove('/sys/mods/x'),
      (e: Error) => e.message.includes('read-only'),
    );
  });
});

describe('deployPrefab', () => {
  let tree: Tree;

  beforeEach(() => {
    clearPrefabs();
    tree = createMemoryTree();
  });
  afterEach(() => clearPrefabs());

  it('deploys prefab nodes to target path', async () => {
    registerPrefab('test', 'basic', [
      { $path: '.', $type: 'dir' } as NodeData,
      { $path: 'child', $type: 'item', label: 'Hello' } as NodeData,
    ]);

    const result = await deployPrefab(tree, '/sys/mods/test/prefabs/basic', '/app', {});
    assert.equal(result.deployed.length, 2);
    assert.equal(result.skipped.length, 0);

    const root = await tree.get('/app');
    assert.equal(root?.$type, 'dir');

    const child = await tree.get('/app/child');
    assert.equal(child?.$type, 'item');
    assert.equal((child as any).label, 'Hello');
  });

  it('idempotent: second deploy skips existing nodes', async () => {
    registerPrefab('test', 'idem', [
      { $path: 'a', $type: 'dir' } as NodeData,
      { $path: 'b', $type: 'dir' } as NodeData,
    ]);

    await deployPrefab(tree, '/sys/mods/test/prefabs/idem', '/x', {});
    const result = await deployPrefab(tree, '/sys/mods/test/prefabs/idem', '/x', {});
    assert.equal(result.deployed.length, 0);
    assert.equal(result.skipped.length, 2);
  });

  it('rejects absolute paths without allowAbsolute', async () => {
    registerPrefab('test', 'abs', [
      { $path: '/sys/autostart/svc', $type: 'ref', $ref: '/x' } as NodeData,
    ]);

    await assert.rejects(
      () => deployPrefab(tree, '/sys/mods/test/prefabs/abs', '/app', {}),
      (e: Error) => e.message.includes('not allowed'),
    );
  });

  it('allows absolute paths with allowAbsolute', async () => {
    registerPrefab('test', 'abs2', [
      { $path: 'local', $type: 'dir' } as NodeData,
      { $path: '/sys/autostart/svc', $type: 'ref', $ref: '/app/svc' } as NodeData,
    ]);

    const result = await deployPrefab(tree, '/sys/mods/test/prefabs/abs2', '/app', {
      allowAbsolute: true,
    });
    assert.equal(result.deployed.length, 2);

    const ref = await tree.get('/sys/autostart/svc');
    assert.equal(ref?.$type, 'ref');

    const local = await tree.get('/app/local');
    assert.equal(local?.$type, 'dir');
  });

  it('setup transforms nodes before deploy', async () => {
    registerPrefab('test', 'setup', [
      { $path: 'cfg', $type: 'config', value: 'PLACEHOLDER' } as NodeData,
    ], (nodes, params) => {
      return nodes.map(n => n.$path === 'cfg'
        ? { ...n, value: (params as any)?.value ?? 'default' }
        : n
      );
    });

    await deployPrefab(tree, '/sys/mods/test/prefabs/setup', '/app', {
      params: { value: 'custom' },
    });

    const cfg = await tree.get('/app/cfg');
    assert.equal((cfg as any).value, 'custom');
  });

  it('throws on invalid source path', async () => {
    await assert.rejects(
      () => deployPrefab(tree, '/bad/path', '/app'),
      (e: Error) => e.message.includes('Invalid prefab path'),
    );
  });

  it('throws on missing prefab', async () => {
    await assert.rejects(
      () => deployPrefab(tree, '/sys/mods/nope/prefabs/nope', '/app'),
      (e: Error) => e.message.includes('not found'),
    );
  });

  it('drops $rev from prefab nodes', async () => {
    registerPrefab('test', 'rev', [
      { $path: 'x', $type: 'dir', $rev: 42 } as NodeData,
    ]);

    await deployPrefab(tree, '/sys/mods/test/prefabs/rev', '/app', {});
    const node = await tree.get('/app/x');
    // $rev should be set by tree (1), not prefab's 42
    assert.notEqual(node?.$rev, 42);
  });

  it('async setup transforms nodes', async () => {
    registerPrefab('test', 'async-setup', [
      { $path: 'cfg', $type: 'config', value: '' } as NodeData,
    ], async (nodes) => {
      await new Promise(r => setTimeout(r, 1));
      return nodes.map(n => ({ ...n, value: 'async-result' }));
    });

    await deployPrefab(tree, '/sys/mods/test/prefabs/async-setup', '/app', {});
    const cfg = await tree.get('/app/cfg');
    assert.equal((cfg as any).value, 'async-result');
  });
});

describe('deployByKey', () => {
  let tree: Tree;

  beforeEach(() => {
    clearPrefabs();
    tree = createMemoryTree();
  });
  afterEach(() => clearPrefabs());

  it('deploys prefab by mod+name without path parsing', async () => {
    registerPrefab('mymod', 'stuff', [
      { $path: '.', $type: 'dir' } as NodeData,
      { $path: 'child', $type: 'item' } as NodeData,
    ]);

    const result = await deployByKey(tree, 'mymod', 'stuff', '/target');
    assert.equal(result.deployed.length, 2);

    assert.equal((await tree.get('/target'))?.$type, 'dir');
    assert.equal((await tree.get('/target/child'))?.$type, 'item');
  });

  it('throws on missing prefab', async () => {
    await assert.rejects(
      () => deployByKey(tree, 'nope', 'nope', '/x'),
      (e: Error) => e.message.includes('not found'),
    );
  });
});

describe('getSeedPrefabs', () => {
  beforeEach(() => clearPrefabs());
  afterEach(() => clearPrefabs());

  it('returns only seed-named prefabs', () => {
    registerPrefab('orders', 'seed', [{ $path: '.', $type: 'dir' } as NodeData]);
    registerPrefab('orders', 'infra', [{ $path: '.', $type: 'dir' } as NodeData]);
    registerPrefab('sim', 'seed', [{ $path: '.', $type: 'dir' } as NodeData]);

    const seeds = getSeedPrefabs();
    assert.equal(seeds.length, 2);
    assert.deepEqual(seeds.map(([mod]) => mod).sort(), ['orders', 'sim']);
  });

  it('returns empty when no seed prefabs', () => {
    registerPrefab('orders', 'infra', [{ $path: '.', $type: 'dir' } as NodeData]);
    assert.equal(getSeedPrefabs().length, 0);
  });
});

describe('deploySeedPrefabs', () => {
  let tree: Tree;

  beforeEach(() => {
    clearPrefabs();
    tree = createMemoryTree();
  });
  afterEach(() => {
    clearPrefabs();
    delete process.env.TENANT;
  });

  it('deploys all seed prefabs to root', async () => {
    registerPrefab('alpha', 'seed', [
      { $path: 'alpha', $type: 'dir' } as NodeData,
      { $path: 'alpha/child', $type: 'item' } as NodeData,
    ]);
    registerPrefab('beta', 'seed', [
      { $path: 'beta', $type: 'dir' } as NodeData,
    ]);

    await deploySeedPrefabs(tree);

    assert.equal((await tree.get('/alpha'))?.$type, 'dir');
    assert.equal((await tree.get('/alpha/child'))?.$type, 'item');
    assert.equal((await tree.get('/beta'))?.$type, 'dir');
  });

  it('allows absolute paths in seed prefabs', async () => {
    registerPrefab('svc', 'seed', [
      { $path: 'svc', $type: 'service' } as NodeData,
      { $path: '/sys/autostart/svc', $type: 'ref', $ref: '/svc' } as NodeData,
    ]);

    await deploySeedPrefabs(tree);

    assert.equal((await tree.get('/svc'))?.$type, 'service');
    assert.equal((await tree.get('/sys/autostart/svc'))?.$type, 'ref');
  });

  it('TENANT mode skips non-core seeds', async () => {
    process.env.TENANT = '1';

    registerPrefab('core', 'seed', [
      { $path: 'sys', $type: 'dir' } as NodeData,
    ], undefined, { tier: 'core' });

    registerPrefab('heavy', 'seed', [
      { $path: 'heavy', $type: 'dir' } as NodeData,
    ]);

    await deploySeedPrefabs(tree);

    assert.equal((await tree.get('/sys'))?.$type, 'dir');
    assert.equal(await tree.get('/heavy'), undefined);
  });

  it('non-TENANT mode deploys all seeds', async () => {
    registerPrefab('core', 'seed', [
      { $path: 'sys', $type: 'dir' } as NodeData,
    ], undefined, { tier: 'core' });

    registerPrefab('heavy', 'seed', [
      { $path: 'heavy', $type: 'dir' } as NodeData,
    ]);

    await deploySeedPrefabs(tree);

    assert.equal((await tree.get('/sys'))?.$type, 'dir');
    assert.equal((await tree.get('/heavy'))?.$type, 'dir');
  });

  it('seed prefab setup receives tree in params', async () => {
    let receivedStore: unknown = null;

    registerPrefab('test', 'seed', [
      { $path: 'test', $type: 'dir' } as NodeData,
    ], (nodes, params) => {
      receivedStore = (params as any)?.tree;
      return nodes;
    });

    await deploySeedPrefabs(tree);

    assert.equal(receivedStore, tree);
  });

  it('idempotent on second run', async () => {
    registerPrefab('idem', 'seed', [
      { $path: 'idem', $type: 'dir' } as NodeData,
    ]);

    await deploySeedPrefabs(tree);
    await deploySeedPrefabs(tree); // should not throw
    assert.equal((await tree.get('/idem'))?.$type, 'dir');
  });
});

describe('t.prefab deploy action', () => {
  let tree: Tree;

  beforeEach(() => {
    clearPrefabs();
    tree = createMemoryTree();
  });
  afterEach(() => clearPrefabs());

  it('deploys prefab nodes via executeAction on t.prefab node', async () => {
    registerPrefab('cafe', 'seed', [
      { $path: 'menu', $type: 'dir' } as NodeData,
      { $path: 'contact', $type: 'cafe.contact' } as NodeData,
    ]);

    const { Prefab } = await import('#mods/treenix/prefab-type');
    await tree.set(createNode('/sys/mods/cafe/prefabs/seed', Prefab, { mod: 'cafe', name: 'seed' }));

    await executeAction(tree, '/sys/mods/cafe/prefabs/seed', 't.prefab', undefined, 'deploy', {
      target: '/sites/demo',
    });

    assert.ok(await tree.get('/sites/demo/menu'));
    assert.equal((await tree.get('/sites/demo/contact'))?.$type, 'cafe.contact');
  });

  it('deploy is idempotent — skips existing nodes', async () => {
    registerPrefab('cafe', 'seed', [
      { $path: 'menu', $type: 'dir' } as NodeData,
    ]);

    const { Prefab } = await import('#mods/treenix/prefab-type');
    await tree.set(createNode('/sys/mods/cafe/prefabs/seed', Prefab, { mod: 'cafe', name: 'seed' }));

    const r1 = await executeAction(tree, '/sys/mods/cafe/prefabs/seed', 't.prefab', undefined, 'deploy', {
      target: '/x',
    }) as { deployed: string[]; skipped: string[] };
    assert.equal(r1.deployed.length, 1);

    const r2 = await executeAction(tree, '/sys/mods/cafe/prefabs/seed', 't.prefab', undefined, 'deploy', {
      target: '/x',
    }) as { deployed: string[]; skipped: string[] };
    assert.equal(r2.deployed.length, 0);
    assert.equal(r2.skipped.length, 1);
  });
});
