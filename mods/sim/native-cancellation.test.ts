import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { it } from 'node:test';
import { instantiateModule } from '@treenx/core/kernel/manifest';
import { createTestInstance } from '@treenx/core/kernel/testing';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import prefabModule from '@treenx/mods/prefab/kernel';
import { installNativeSeeds } from '@treenx/mods/prefab/install';
import createNativeSim from './kernel';
import { part, readNode } from './native-data';
import { SimNearby, SimPosition, SimRound } from './types';
import type { SimTool } from './native-io';
import { runRound } from './native-round';
import type { ModuleManifest, WriteActionContext } from '@treenx/core/kernel/types';

it(
  'stop aborts a stuck model request and lands no round or proximity writes after it resolves',
  { timeout: 10000 },
  async (t) => {
    let signal: AbortSignal | undefined;
    let entered = () => {};
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sim = createNativeSim({
      sim: {
        provider: (_request, current) => {
          signal = current;
          entered();
          return new Promise<SimTool[]>((_resolve, reject) => {
            current.addEventListener('abort', () => reject(current.reason), { once: true });
          });
        },
      },
    });
    const autostart = await instantiateModule(
      {
        collectionId: '@treenx/core/autostart',
        factory: async () => (await import('../../core/src/mods/autostart/kernel')).default(),
      },
      {},
    );
    const test = await createTestInstance({
      modules: [sim.manifest, autostart, (await prefabModule()).manifest],
      io: sim.io,
      seed: [],
      actors: {},
    });
    t.after(() => test.close());
    assert.ok(test.instance.setupCredential);
    const admin = await test.instance.openSession(test.instance.setupCredential);
    const delivery = drainSession(admin);
    t.after(async () => {
      admin.close();
      await delivery;
    });
    const key = () => ({
      epoch: test.instance.writer.intake.epoch,
      time: Date.now(),
      nonce: randomUUID(),
    });
    assert.ok(sim.seeds);
    // This unit owns one service Session; automatic discovery must not open a second owner.
    const seed = {
      ...sim.seeds,
      prefabs: sim.seeds.prefabs.map((prefab) => ({
        ...prefab,
        source: {
          ...prefab.source,
          nodes: prefab.source.nodes.filter((node) => node.$path !== '/sys/autostart/sim'),
        },
      })),
    };
    await installNativeSeeds(admin, { ...seed, opId: key() });
    await admin.act({
      path: '/sim/world/alice',
      action: 'move',
      args: { x: 100, y: 100 },
      opId: key(),
    }).outcome;
    await admin.act({ path: '/sim/world', action: 'start', args: {}, opId: key() }).outcome;
    const owner = await test.instance.openNodeSession('/sim/service');
    const service = sim.manifest.security[0];
    assert.ok(service.context === 'service');
    const run = await service.handler(await readNode(admin, '/sim/service'), owner);
    t.after(async () => {
      owner.close();
      await run.stop();
    });
    await requested;
    const before = await readNode(admin, '/sim/world');
    const roundBefore = part(before, SimRound).current;
    const agentBefore = await readNode(admin, '/sim/world/alice');
    const nearbyBefore = getComponent(agentBefore, SimNearby);
    owner.close();
    await run.stop();
    assert.ok(signal?.aborted, 'stop must abort the in-flight model request');
    const after = await readNode(admin, '/sim/world');
    assert.equal(
      part(after, SimRound).current,
      roundBefore,
      'round must not advance after stop resolves',
    );
    const agentAfter = await readNode(admin, '/sim/world/alice');
    assert.deepEqual(
      getComponent(agentAfter, SimNearby),
      nearbyBefore,
      'proximity write must not land after stop resolves',
    );
    assert.equal(after.$rev, before.$rev);
    assert.equal(agentAfter.$rev, agentBefore.$rev);
  },
);

it(
  'stop while a move tool reads its agent lands no movement or round writes',
  { timeout: 10000 },
  async (t) => {
    let toolsReturned = false;
    let entered = () => {};
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const heldRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sim = createNativeSim({
      sim: {
        provider: async (request) => {
          if (request.name !== 'Alice') return [];
          toolsReturned = true;
          return [{ tool: 'move', x: 999, y: 999 }];
        },
      },
    });
    t.after(() => release());
    const manifest: ModuleManifest = {
      ...sim.manifest,
      types: sim.manifest.types.map((type) => {
        if (type.name !== 'sim.world') return type;
        const round = type.actions.round;
        assert.ok(round.kind === 'write' && round.post === undefined);
        return {
          ...type,
          actions: {
            ...type.actions,
            round: {
              ...round,
              handler: (ctx: WriteActionContext) =>
                runRound({
                  ...ctx,
                  read: {
                    ...ctx.read,
                    async read(selector) {
                      if (
                        toolsReturned &&
                        'node' in selector &&
                        selector.node === '/sim/world/alice'
                      ) {
                        entered();
                        await heldRead;
                      }
                      return ctx.read.read(selector);
                    },
                  },
                }),
            },
          },
        };
      }),
    };
    const autostart = await instantiateModule(
      {
        collectionId: '@treenx/core/autostart',
        factory: async () => (await import('../../core/src/mods/autostart/kernel')).default(),
      },
      {},
    );
    const test = await createTestInstance({
      modules: [manifest, autostart, (await prefabModule()).manifest],
      io: sim.io,
      seed: [],
      actors: {},
    });
    t.after(() => test.close());
    assert.ok(test.instance.setupCredential);
    const admin = await test.instance.openSession(test.instance.setupCredential);
    const delivery = drainSession(admin);
    t.after(async () => {
      admin.close();
      await delivery;
    });
    const key = () => ({
      epoch: test.instance.writer.intake.epoch,
      time: Date.now(),
      nonce: randomUUID(),
    });
    assert.ok(sim.seeds);
    // This unit owns one service Session; automatic discovery must not open a second owner.
    const seed = {
      ...sim.seeds,
      prefabs: sim.seeds.prefabs.map((prefab) => ({
        ...prefab,
        source: {
          ...prefab.source,
          nodes: prefab.source.nodes.filter((node) => node.$path !== '/sys/autostart/sim'),
        },
      })),
    };
    await installNativeSeeds(admin, { ...seed, opId: key() });
    await admin.act({
      path: '/sim/world/alice',
      action: 'move',
      args: { x: 100, y: 100 },
      opId: key(),
    }).outcome;
    await admin.act({
      path: '/sim/world',
      action: 'start',
      args: {},
      opId: key(),
    }).outcome;
    const owner = await test.instance.openNodeSession('/sim/service');
    const service = sim.manifest.security[0];
    assert.ok(service.context === 'service');
    const run = await service.handler(await readNode(admin, '/sim/service'), owner);
    t.after(async () => {
      owner.close();
      await run.stop();
    });
    await requested;
    const before = await readNode(admin, '/sim/world');
    const roundBefore = part(before, SimRound).current;
    const agentBefore = await readNode(admin, '/sim/world/alice');
    const nearbyBefore = getComponent(agentBefore, SimNearby);
    owner.close();
    const stopping = run.stop();
    release();
    await stopping;
    const after = await readNode(admin, '/sim/world');
    assert.equal(
      part(after, SimRound).current,
      roundBefore,
      'round must not advance after stop resolves',
    );
    const agentAfter = await readNode(admin, '/sim/world/alice');
    assert.deepEqual(
      getComponent(agentAfter, SimNearby),
      nearbyBefore,
      'proximity write must not land after stop resolves',
    );
    assert.equal(after.$rev, before.$rev);
    assert.equal(agentAfter.$rev, agentBefore.$rev);
    assert.deepEqual(part(agentAfter, SimPosition), part(agentBefore, SimPosition));
    assert.deepEqual(part(after, SimRound).log, part(before, SimRound).log);
  },
);
