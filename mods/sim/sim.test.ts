// AgentSim tests — round engine, proximity, tools, quorum

import { createNode, getComponent, resolve } from '@treenx/core';
import { SimPosition } from './types';
import type { ServiceHandle } from '@treenx/core/contexts/service';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { withExecute } from '@treenx/core/server/actions';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
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
  return tree.get(worldPath).then(w => svc(w!, { tree: withExecute(tree), path: worldPath, subscribe: () => () => {} }));
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

    // Mock agents move randomly each round, so assert the proximity contract
    // against the ACTUAL final positions, not the initial ones.
    const a = await tree.get('/w/a');
    const b = await tree.get('/w/b');
    const pa = getComponent(a!, SimPosition)!;
    const pb = getComponent(b!, SimPosition)!;
    const nearby = getComponent(a!, 'sim.nearby') as any;
    assert.ok(nearby);
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    assert.equal(nearby.agents.includes('Bob'), d <= pa.radius);
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
    const speakEvents = round.log.filter((e: any) => typeof e.action === 'string' && e.action.startsWith('speak'));
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

// Codex hardening of 8c21727: stop() must not run a round / mutate / hang after
// landing mid-await (holes: loop tree.get, wake timer, throwing runRound, stuck fetch).
describe('stop() lifecycle hardening', () => {
  const realFetch = globalThis.fetch;
  const hadKey = 'ANTHROPIC_API_KEY' in process.env;
  const realKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.ANTHROPIC_API_KEY = realKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  // Gate tree.get so the Nth get of '/w' parks until released with 'pass' | 'throw'.
  function parkWorldGet(nth: number) {
    const origGet = tree.get;
    let n = 0;
    let onParked!: () => void;
    const parked = new Promise<void>((r) => { onParked = r; });
    let release!: (mode: 'pass' | 'throw') => void;
    const held = new Promise<'pass' | 'throw'>((r) => { release = r; });
    const gated: Tree['get'] = async (path, gctx) => {
      if (path === '/w') {
        n++;
        if (n === nth) {
          onParked();
          if ((await held) === 'throw') throw new Error('injected get failure');
        }
      }
      return origGet(path, gctx);
    };
    tree.get = gated;
    return { parked, release, origGet };
  }

  function startInline(w0: NonNullable<Awaited<ReturnType<Tree['get']>>>): Promise<ServiceHandle> {
    const svc = resolve('sim.world', 'service')!;
    return svc(w0, { tree: withExecute(tree), path: '/w', subscribe: () => () => {} });
  }

  it('stop() while parked in the loop tree.get runs no round and mutates nothing', { timeout: 3000 }, async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));
    const w0 = await tree.get('/w');

    const gate = parkWorldGet(1); // park the loop's very first world get
    const handle = await startInline(w0!);
    await gate.parked;

    const stopping = handle.stop(); // stopped=true, then awaits the parked loop
    gate.release('pass'); // let the get resolve — loop must see stopped and break
    await stopping;

    const w = await gate.origGet('/w', undefined);
    assert.equal((getComponent(w!, 'sim.round') as any).current, 0, 'no round after stop');
    const a = await gate.origGet('/w/a', undefined);
    assert.equal(getComponent(a!, 'sim.nearby'), undefined, 'agent untouched after stop');
  });

  it('stop() resolves via wake without waiting out roundDelay', { timeout: 2000 }, async () => {
    // running=false → loop sleeps roundDelay; a broken wake would block 100s.
    await tree.set(createNode('/w', 'sim.world', {}, {
      config: { $type: 'sim.config', width: 600, height: 400, roundDelay: 100000, running: false },
      round: { $type: 'sim.round', current: 0, phase: 'idle', log: [] },
    }));
    const handle: ServiceHandle = await startService('/w');
    await handle.stop();

    const w = await tree.get('/w');
    assert.equal((getComponent(w!, 'sim.round') as any).current, 0);
  });

  it('stop() during a throwing runRound does not wait out the error backoff', { timeout: 3000 }, async () => {
    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));
    const w0 = await tree.get('/w');

    const gate = parkWorldGet(2); // get#1 = loop, get#2 = runRound's world read
    const handle = await startInline(w0!);
    await gate.parked;

    const stopping = handle.stop();
    gate.release('throw'); // runRound throws → catch must break, not sleep(5000)
    await stopping;

    const w = await gate.origGet('/w', undefined);
    assert.equal((getComponent(w!, 'sim.round') as any).current, 0, 'round did not advance');
  });

  it('stop() aborts a stuck LLM request AND lands no tree writes after it resolves', { timeout: 3000 }, async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let sig: AbortSignal | undefined;
    let onFetch!: () => void;
    const fetched = new Promise<void>((r) => { onFetch = r; });
    globalThis.fetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_res, reject) => {
          sig = init?.signal ?? undefined;
          onFetch();
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')));
        }),
      { preconnect: realFetch.preconnect },
    );

    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));

    const handle: ServiceHandle = await startService('/w');
    await fetched; // LLM fetch is in flight and blocked, mid-runRound

    // Snapshot the mutable state the aborted round would touch: the round counter
    // and the proximity cache. Abort empties tools to [] but must NOT let the round
    // recompute proximity or advance — those writes must never land (hardens 8c21727).
    const before = await tree.get('/w');
    const roundBefore = (getComponent(before!, 'sim.round') as any).current;
    const aBefore = await tree.get('/w/a');
    const nearbyBefore = getComponent(aBefore!, 'sim.nearby');

    await handle.stop(); // aborts the fetch, joins the loop, no writes may follow

    assert.ok(sig?.aborted, 'stop() must abort the in-flight LLM request');

    const after = await tree.get('/w');
    assert.equal((getComponent(after!, 'sim.round') as any).current, roundBefore,
      'round must not advance after stop() resolves');
    const aAfter = await tree.get('/w/a');
    assert.equal(getComponent(aAfter!, 'sim.nearby'), nearbyBefore,
      'proximity write must not land after stop() resolves');
  });

  // Round-2: a stop() landing WHILE a tool branch is awaiting mid-write must not
  // let the post-await mutation land. Drive a deterministic move tool and park the
  // move branch's agent get, then stop() before releasing it.
  it('stop() while the move tool branch is parked on the agent get lands no write', { timeout: 3000 }, async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = Object.assign(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({ content: [{ type: 'tool_use', name: 'move', input: { x: 500, y: 300 } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      { preconnect: realFetch.preconnect },
    );

    await tree.set(world('/w', true));
    await tree.set(agent('/w/a', 'Alice', 'A', 100, 100));

    // The move branch issues the FIRST tree.get('/w/a'); park it there.
    const origGet = tree.get;
    let onParked!: () => void;
    const parked = new Promise<void>((r) => { onParked = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let seen = 0;
    const gated: Tree['get'] = async (path, gctx) => {
      if (path === '/w/a' && ++seen === 1) {
        onParked();
        await held;
      }
      return origGet(path, gctx);
    };
    tree.get = gated;

    const w0 = await origGet('/w', undefined);
    const handle = await startInline(w0!);
    await parked; // inside the move branch, blocked on the agent get

    const before = await origGet('/w/a', undefined);
    const posBefore = getComponent(before!, SimPosition)!;
    const wBefore = await origGet('/w', undefined);
    const roundBefore = (getComponent(wBefore!, 'sim.round') as any).current;

    const stopping = handle.stop(); // stopped=true; joins the loop parked at the agent get
    release();                       // get resolves — barrier must return before the move set
    await stopping;

    const after = await origGet('/w/a', undefined);
    const posAfter = getComponent(after!, SimPosition)!;
    assert.equal(posAfter.x, posBefore.x, 'move must not write x after stop()');
    assert.equal(posAfter.y, posBefore.y, 'move must not write y after stop()');
    const wAfter = await origGet('/w', undefined);
    assert.equal((getComponent(wAfter!, 'sim.round') as any).current, roundBefore,
      'round must not advance after stop()');
  });
});
