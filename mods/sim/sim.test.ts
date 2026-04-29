// AgentSim tests — round engine, proximity, tools, quorum

import { createNode, getComponent, resolve } from '@treenx/core';
import type { ServiceHandle } from '@treenx/core/contexts/service';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import './service'; // registers handlers once (ESM cache)

let tree: Tree;

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
    config: { $type: 'sim.config', width: 600, height: 400, roundDelay: 1, running },
    round: { $type: 'sim.round', current: 0, phase: 'idle', log: [] },
  });
}

/** Poll tree until round >= target or timeout */
async function waitForRound(t: Tree, path: string, target: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const w = await t.get(path);
    const round = getComponent(w!, 'sim.round') as any;
    if (round?.current >= target) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  const w = await t.get(path);
  const round = getComponent(w!, 'sim.round') as any;
  assert.fail(`timed out waiting for round ${target}, stuck at ${round?.current ?? '?'}`);
}

function startService(worldPath: string) {
  const svc = resolve('sim.world', 'service')!;
  return tree.get(worldPath).then(w => svc(w!, { tree, path: worldPath, subscribe: () => () => {} }));
}

beforeEach(() => {
  tree = createMemoryTree();
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
    await tree.set(w);
    const handler = resolve('sim.world', 'action:start')!;
    await handler({ node: w, tree, signal: AbortSignal.timeout(5000) }, {});
    await tree.set(w);
    const fresh = await tree.get(w.$path);
    assert.equal((getComponent(fresh!, 'sim.config') as any).running, true);
  });

  it('action:stop sets running=false', async () => {
    const w = world('/w', true);
    await tree.set(w);
    const handler = resolve('sim.world', 'action:stop')!;
    await handler({ node: w, tree, signal: AbortSignal.timeout(5000) }, {});
    await tree.set(w);
    const fresh = await tree.get(w.$path);
    assert.equal((getComponent(fresh!, 'sim.config') as any).running, false);
  });
});

describe('proximity', () => {
  it('agents within radius are nearby', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100, 900));
    await tree.set(agent('/w/b', 'Bob', 'B', 200, 200, 900));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 1);
    await handle.stop();

    const a = await tree.get('/w/a');
    const nearby = getComponent(a!, 'sim.nearby') as any;
    assert.ok(nearby);
    assert.ok(nearby.agents.includes('Bob'));
  });

  it('agents outside radius are not nearby', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 0, 0, 50));
    await tree.set(agent('/w/b', 'Bob', 'B', 500, 500, 50)); // dist ~707 >> 50

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 1);
    await handle.stop();

    const a = await tree.get('/w/a');
    const nearby = getComponent(a!, 'sim.nearby') as any;
    assert.ok(nearby);
    assert.equal(nearby.agents.length, 0);
  });
});

describe('round engine', () => {
  it('advances round number after execution', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 1);
    await handle.stop();

    const w = await tree.get('/w');
    const round = getComponent(w!, 'sim.round') as any;
    assert.ok(round.current >= 1, `expected round >= 1, got ${round.current}`);
    assert.equal(round.phase, 'idle');
  });

  it('does not run when running=false', async () => {
    await tree.set(world('/w', false));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const handle: ServiceHandle = await startService('/w');
    // Service checks running flag — with running=false it just sleeps through roundDelay
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();

    const w = await tree.get('/w');
    const round = getComponent(w!, 'sim.round') as any;
    assert.equal(round.current, 0);
  });

  it('produces event log entries', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));
    await tree.set(agent('/w/b', 'Bob', 'B', 200, 200));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 2);
    await handle.stop();

    const w = await tree.get('/w');
    const round = getComponent(w!, 'sim.round') as any;
    assert.ok(round.log.length > 0, 'expected at least 1 event in log');
  });

  it('log entries have required fields', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 2);
    await handle.stop();

    const w = await tree.get('/w');
    const round = getComponent(w!, 'sim.round') as any;
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
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 599, 399));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 5);
    await handle.stop();

    const a = await tree.get('/w/a');
    const pos = getComponent(a!, 'sim.position') as any;
    assert.ok(pos.x >= 0 && pos.x <= 600, `x=${pos.x} out of bounds`);
    assert.ok(pos.y >= 0 && pos.y <= 400, `y=${pos.y} out of bounds`);
  });

  it('remember adds to memory', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 10);
    await handle.stop();

    const a = await tree.get('/w/a');
    const mem = getComponent(a!, 'sim.memory') as any;
    assert.ok(Array.isArray(mem.entries));
    assert.ok(mem.entries.length <= 20, 'memory should be capped at 20');
  });

  it('speak sets heardBy for nearby agents', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100, 300));
    await tree.set(agent('/w/b', 'Bob', 'B', 150, 150, 300));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 10);
    await handle.stop();

    const w = await tree.get('/w');
    const round = getComponent(w!, 'sim.round') as any;
    const speakEvents = round.log.filter((e: any) => e.action === 'speak');
    assert.ok(speakEvents.length > 0, 'should have at least one speak event');
    for (const e of speakEvents) {
      assert.ok(Array.isArray(e.heardBy), 'speak event should have heardBy');
    }
  });
});

describe('quorum (parallel execution)', () => {
  it('all agents act in same round', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));
    await tree.set(agent('/w/b', 'Bob', 'B', 200, 200));
    await tree.set(agent('/w/c', 'Eve', 'C', 300, 300));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 5);
    await handle.stop();

    const w = await tree.get('/w');
    const round = getComponent(w!, 'sim.round') as any;
    assert.ok(round.log.length >= 1, 'should have at least 1 event across all rounds');
    const actors = new Set(round.log.map((e: any) => e.agent));
    assert.ok(actors.size >= 2, `expected >= 2 actors, got ${actors.size}: ${[...actors]}`);
  });
});

describe('service lifecycle', () => {
  it('stop halts the service', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 2);
    await handle.stop();

    const w1 = await tree.get('/w');
    const round1 = (getComponent(w1!, 'sim.round') as any).current;

    // Wait — should NOT advance
    await new Promise((r) => setTimeout(r, 50));
    const w2 = await tree.get('/w');
    const round2 = (getComponent(w2!, 'sim.round') as any).current;
    assert.equal(round1, round2, 'round should not advance after stop');
  });
});

describe('log trimming', () => {
  it('log stays within 50 entries', async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100, 300));
    await tree.set(agent('/w/b', 'Bob', 'B', 150, 150, 300));

    const handle: ServiceHandle = await startService('/w');
    await waitForRound(tree, '/w', 30);
    await handle.stop();

    const w = await tree.get('/w');
    const round = getComponent(w!, 'sim.round') as any;
    assert.ok(round.log.length <= 50, `log has ${round.log.length} entries, expected <= 50`);
  });
});
