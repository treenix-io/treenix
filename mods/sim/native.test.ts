import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import type { Position } from '@treenx/core/kernel/types';
import { instantiateModule } from '@treenx/core/kernel/manifest';
import prefabModule from '@treenx/mods/prefab/kernel';
import { createInstance } from '../../core/src/kernel/instance';
import { installNativeSeeds } from '@treenx/mods/prefab/install';
import { createMemoryStore } from '@treenx/core/kernel/store/memory';
import { createMemoryBlobStore } from '@treenx/core/kernel/blob-store-memory';
import { createLaneCache } from '@treenx/core/client/lane-cache';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import { part, readNode } from './native-data';
import {
  SimAi,
  SimConfig,
  SimRound,
  SimMemory,
  SimEvents,
  SimPosition,
  SimNearby,
  SimDescriptive,
} from './types';
import createNativeSim from './kernel';

it(
  'runs the seeded map, native discovered actions and one model round under its service principal',
  { timeout: 10000 },
  async (test) => {
    const prompts: string[] = [];
    const sim = createNativeSim({
      sim: {
        provider: async (request) => {
          prompts.push(request.system);
          return request.name === 'Alice'
            ? [
                { tool: 'speak', message: 'Hello Eve', to: 'Eve' },
                { tool: 'move', x: 100, y: 350 },
                { tool: 'remember', text: 'The crystal glows' },
                { tool: 'interact', target: 'Crystal', action: 'use', data: { how: 'inspect' } },
              ]
            : [{ tool: 'remember', text: `${request.name} observes` }];
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
    const id = randomUUID(),
      store = createMemoryStore({ domain: id });
    let saved: Position | undefined;
    const instance = await createInstance({
      id,
      root: { kind: 'store', store },
      blobs: createMemoryBlobStore(),
      modules: [sim.manifest, autostart, (await prefabModule()).manifest],
      io: sim.io,
      provisioning: {
        writerEpoch: 1,
        domains: [{ store, epoch: randomUUID(), persistent: false }],
        credentialTtlMs: 60000,
        counter: {
          async load() {
            return saved;
          },
          async save(position) {
            saved = position;
          },
          async freshEpoch(floor) {
            return floor + 1;
          },
        },
        bootstrap: {
          kind: 'fresh',
          admin: { path: '/admin', name: 'admin', password: randomUUID() },
        },
      },
    });
    test.after(() => instance.close());

    const admin = await instance.openSession(instance.setupCredential),
      delivery = drainSession(admin);
    test.after(async () => {
      admin.close();
      await delivery;
    });
    const key = () => ({
      epoch: instance.writer.intake.epoch,
      time: Date.now(),
      nonce: randomUUID(),
    });
    /** Call the original public actions through the native session. */
    async function act(path: string, action: string, args: unknown = undefined) {
      return (await admin.act({ path, action, args, opId: key() }).outcome).value;
    }
    assert.ok(sim.seeds);
    await installNativeSeeds(admin, { ...sim.seeds, opId: key() });
    assert.equal((await readNode(admin, '/sys/autostart/sim')).$ref, '/sim/service');
    assert.equal(part(await readNode(admin, '/sim/world'), SimConfig).running, false);
    await act('/sim/world', 'set-config', { roundDelay: 60000 });
    await act('/sim/world/eve', 'update', { description: 'Artist watching the crystal' });
    assert.equal(
      part(await readNode(admin, '/sim/world/eve'), SimDescriptive).description,
      'Artist watching the crystal',
    );
    await act('/sim/world/eve', 'move', { x: 300, y: 100 });
    assert.deepEqual(await act('/sim/world/crystal', 'examine'), {
      description: 'A mysterious glowing crystal. It hums softly when touched.',
    });

    const priorLog = Array.from({ length: 50 }, (_, index) => ({
      round: 0,
      agent: 'Earlier',
      icon: '',
      action: `earlier-${index}`,
      data: {},
      ts: index,
    }));
    await admin.commit({
      opId: key(),
      changes: [
        {
          op: 'patch',
          path: '/sim/world',
          ops: {
            $set: {
              '#round': {
                $type: 'sim.round',
                current: 0,
                phase: 'idle',
                log: priorLog,
              },
            },
          },
        },
      ],
    }).outcome;

    const observer = await instance.openSession(instance.setupCredential);
    observer.sub({ node: '/sim/world' });
    let resolveRound = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveRound = resolve;
    });
    const cache = createLaneCache();
    const observed = (async () => {
      for await (const frame of observer.lane) {
        cache.apply(frame);
        const copy = cache.at('/sim/world');
        if (copy === undefined) continue;
        if ('error' in copy) throw copy.error;
        if (part(copy.node, SimRound).current === 1) resolveRound();
      }
    })();
    test.after(async () => {
      observer.close();
      await observed;
    });
    const nodeSession = await instance.openNodeSession('/sim/service');
    const service = sim.manifest.security[0];
    assert.equal(service.context, 'service');
    assert.ok(service.context === 'service');
    const run = await service.handler(await readNode(admin, '/sim/service'), nodeSession);
    test.after(async () => {
      nodeSession.close();
      await run.stop();
    });
    await act('/sim/world', 'start');
    await Promise.race([finished, run.done]);
    await act('/sim/world', 'stop');
    const world = await readNode(admin, '/sim/world'),
      round = part(world, SimRound);
    assert.equal(round.current, 1);
    assert.equal(round.phase, 'idle');
    assert.equal(part(world, SimConfig).running, false);
    assert.equal(prompts.length, 4);
    assert.ok(prompts.some((prompt) => prompt.includes('examine') && prompt.includes('use')));
    const alice = await readNode(admin, '/sim/world/alice');
    assert.equal(part(alice, SimPosition).x, 100);
    assert.equal(part(alice, SimPosition).y, 350);
    assert.deepEqual(part(alice, SimMemory).entries, ['The crystal glows']);
    assert.ok(part(alice, SimNearby).agents.includes('Crystal'));
    assert.equal(part(alice, SimNearby).agents.includes('Bob'), false);
    assert.ok(
      part(await readNode(admin, '/sim/world/eve'), SimEvents).entries.some(
        (event) => event.type === 'speak' && event.from === 'Alice',
      ),
    );
    assert.equal(round.log.length, 50);
    assert.deepEqual(round.log.slice(0, 47), priorLog.slice(3));
    assert.deepEqual(
      round.log.slice(-3).map((entry) => entry.action),
      ['speak→Eve', 'move', 'interact→Crystal.use'],
    );
    assert.equal(round.log[49].action, 'interact→Crystal.use');
    assert.equal(
      JSON.stringify(round.log[49].data.result),
      JSON.stringify({ result: 'You used Crystal. inspect' }),
    );
    await act('/sim/world', 'add-entity', { id: 'new-agent', name: 'New', type: 'sim.agent' });
    assert.equal(
      part(await readNode(admin, '/sim/world/new-agent'), SimAi).systemPrompt,
      'You are New.',
    );
  },
);
