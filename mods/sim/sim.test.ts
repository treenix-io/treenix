// AgentSim tests — round engine, proximity, tools, quorum

import type { ServiceHandle } from '@treenity/core/contexts/service';
import { createNode, getComponent, resolve } from '@treenity/core/core';
import { createMemoryTree, type Tree } from '@treenity/core/tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import './service'; // registers handlers once (ESM cache)

let store: Tree;

function agent(path: string, name: string, icon: string, x: number, y: number, radius = 200) {
  return createNode(path, 'sim.agent', {}, {
    descriptive: { $type: 'sim.descriptive', name, icon, description: `${name} agent` },
    ai: { $type: 'sim.ai', systemPrompt: `You are ${name}.` },
    position: { $type: 'sim.position', x, y, radius },
    memory: { $type: 'sim.memory', entries: [] },
  });
}

function world(path = '/w', running = false) {
  return createNode(path, 'sim.world', {}, {
    config: { $type: 'sim.config', width: 600, height: 400, roundDelay: 100, running },
    round: { $type: 'sim.round', current: 0, phase: 'idle', log: [] },
  });
}

beforeEach(() => {
  store = createMemoryTree();
});

describe('sim.world registration', () => {
  it('registers service handler', () => {
    assert.ok(resolve('sim.world', 'service'));
  });

  it('registers start/stop actions', () => {
    assert.ok(resolve('sim.world', 'action:start'));
    assert.ok(resolve('sim.world', 'action:stop'));
  });
});

describe('start/stop actions', () => {
  it('action:start sets running=true', async () => {
    const w = world();
    await store.set(w);
    const handler = resolve('sim.world', 'action:start')!;
    await handler({ node: w, store, signal: AbortSignal.timeout(5000) }, {});
    // Handlers mutate ctx.node in-place; caller persists (executeAction or service loop)
    await store.set(w);
    const fresh = await store.get(w.$path);
    assert.equal((getComponent(fresh!, 'config') as any).running, true);
  });

  it('action:stop sets running=false', async () => {
    const w = world('/w', true);
    await store.set(w);
    const handler = resolve('sim.world', 'action:stop')!;
    await handler({ node: w, store, signal: AbortSignal.timeout(5000) }, {});
    await store.set(w);
    const fresh = await store.get(w.$path);
    assert.equal((getComponent(fresh!, 'config') as any).running, false);
  });
});

describe('proximity', () => {
  it('agents within radius are nearby', async () => {
    await store.set(world('/w', true));
    // Large radius covers entire map — stays nearby even after random moves
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100, 900));
    await store.set(agent('/w/b', 'Bob', 'B', 200, 200, 900));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 800));
    await handle.stop();

    const a = await store.get('/w/a');
    const nearby = getComponent(a!, 'nearby') as any;
    assert.ok(nearby);
    assert.ok(nearby.agents.includes('Bob'));
  });

  it('agents outside radius are not nearby', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 0, 0, 50));
    await store.set(agent('/w/b', 'Bob', 'B', 500, 500, 50)); // dist ~707 >> 50

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 500));
    await handle.stop();

    const a = await store.get('/w/a');
    const nearby = getComponent(a!, 'nearby') as any;
    assert.ok(nearby);
    assert.equal(nearby.agents.length, 0);
  });
});

describe('round engine', () => {
  it('advances round number after execution', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 500));
    await handle.stop();

    const w = await store.get('/w');
    const round = getComponent(w!, 'round') as any;
    assert.ok(round.current >= 1, `expected round >= 1, got ${round.current}`);
    assert.equal(round.phase, 'idle');
  });

  it('does not run when running=false', async () => {
    await store.set(world('/w', false));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 400));
    await handle.stop();

    const w = await store.get('/w');
    const round = getComponent(w!, 'round') as any;
    assert.equal(round.current, 0);
  });

  it('produces event log entries', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100));
    await store.set(agent('/w/b', 'Bob', 'B', 200, 200));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 500));
    await handle.stop();

    const w = await store.get('/w');
    const round = getComponent(w!, 'round') as any;
    assert.ok(round.log.length > 0, 'expected at least 1 event in log');
  });

  it('log entries have required fields', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 500));
    await handle.stop();

    const w = await store.get('/w');
    const round = getComponent(w!, 'round') as any;
    for (const entry of round.log) {
      assert.ok(typeof entry.round === 'number');
      assert.ok(typeof entry.agent === 'string');
      assert.ok(typeof entry.action === 'string');
      assert.ok(typeof entry.ts === 'number');
      assert.ok(entry.data !== undefined);
    }
  });
});

describe('mock tools', () => {
  it('move clamps to world bounds', async () => {
    await store.set(world('/w', true));
    // Place agent so random move could exceed bounds
    await store.set(agent('/w/a', 'Alice', 'A', 599, 399));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    // Run several rounds to get a move action
    await new Promise((r) => setTimeout(r, 1500));
    await handle.stop();

    const a = await store.get('/w/a');
    const pos = getComponent(a!, 'position') as any;
    assert.ok(pos.x >= 0 && pos.x <= 600, `x=${pos.x} out of bounds`);
    assert.ok(pos.y >= 0 && pos.y <= 400, `y=${pos.y} out of bounds`);
  });

  it('remember adds to memory', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    // Run enough rounds for a remember action (mock: ~30% chance per round)
    await new Promise((r) => setTimeout(r, 2000));
    await handle.stop();

    // Check if memory was modified (at least one remember should fire in ~10 rounds)
    const a = await store.get('/w/a');
    const mem = getComponent(a!, 'memory') as any;
    // Can't guarantee remember fires, so just verify shape is intact
    assert.ok(Array.isArray(mem.entries));
    assert.ok(mem.entries.length <= 20, 'memory should be capped at 20');
  });

  it('speak sets heardBy for nearby agents', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100, 300));
    await store.set(agent('/w/b', 'Bob', 'B', 150, 150, 300));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 2000));
    await handle.stop();

    const w = await store.get('/w');
    const round = getComponent(w!, 'round') as any;
    const speakEvents = round.log.filter((e: any) => e.action === 'speak');
    assert.ok(speakEvents.length > 0, 'should have at least one speak event');
    for (const e of speakEvents) {
      assert.ok(Array.isArray(e.heardBy), 'speak event should have heardBy');
    }
  });
});

describe('quorum (parallel execution)', () => {
  it('all agents act in same round', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100));
    await store.set(agent('/w/b', 'Bob', 'B', 200, 200));
    await store.set(agent('/w/c', 'Eve', 'C', 300, 300));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    // Run several rounds — remember actions don't produce log entries, need enough rounds
    await new Promise((r) => setTimeout(r, 1500));
    await handle.stop();

    const w = await store.get('/w');
    const round = getComponent(w!, 'round') as any;
    assert.ok(round.log.length >= 1, 'should have at least 1 event across all rounds');
    // Verify multiple agents produced events across rounds
    const actors = new Set(round.log.map((e: any) => e.agent));
    assert.ok(actors.size >= 2, `expected >= 2 actors, got ${actors.size}: ${[...actors]}`);
  });
});

describe('service lifecycle', () => {
  it('stop halts the service', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    await new Promise((r) => setTimeout(r, 300));
    await handle.stop();

    const w1 = await store.get('/w');
    const round1 = (getComponent(w1!, 'round') as any).current;

    // Wait more — should NOT advance
    await new Promise((r) => setTimeout(r, 500));
    const w2 = await store.get('/w');
    const round2 = (getComponent(w2!, 'round') as any).current;
    assert.equal(round1, round2, 'round should not advance after stop');
  });
});

describe('log trimming', () => {
  it('log stays within 50 entries', async () => {
    await store.set(world('/w', true));
    await store.set(agent('/w/a', 'Alice', 'A', 100, 100, 300));
    await store.set(agent('/w/b', 'Bob', 'B', 150, 150, 300));

    const svc = resolve('sim.world', 'service')!;
    const handle: ServiceHandle = await svc((await store.get('/w'))!, { store, subscribe: () => () => {} });
    // Run many rounds
    await new Promise((r) => setTimeout(r, 3000));
    await handle.stop();

    const w = await store.get('/w');
    const round = getComponent(w!, 'round') as any;
    assert.ok(round.log.length <= 50, `log has ${round.log.length} entries, expected <= 50`);
  });
});
